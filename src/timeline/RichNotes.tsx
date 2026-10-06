// Rich-text task notes (Lexical). Stored as markdown in the task's `notes`
// cell, so plain notes (and Teamweek imports with "- " lists and bare links)
// open as formatted text, and the CRDT still merges a plain string.
//
// Loaded on demand (see Editor.tsx) to keep Lexical out of the first paint.

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { ListPlugin } from '@lexical/react/LexicalListPlugin';
import { LinkPlugin } from '@lexical/react/LexicalLinkPlugin';
import { AutoLinkPlugin, createLinkMatcherWithRegExp } from '@lexical/react/LexicalAutoLinkPlugin';
import { ClickableLinkPlugin } from '@lexical/react/LexicalClickableLinkPlugin';
import { MarkdownShortcutPlugin } from '@lexical/react/LexicalMarkdownShortcutPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { ListItemNode, ListNode, INSERT_ORDERED_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND, REMOVE_LIST_COMMAND, $isListNode } from '@lexical/list';
import { AutoLinkNode, LinkNode, TOGGLE_LINK_COMMAND, $isLinkNode } from '@lexical/link';
import { CodeNode } from '@lexical/code';
import { $convertFromMarkdownString, $convertToMarkdownString, TRANSFORMERS } from '@lexical/markdown';
import { $createParagraphNode, $getSelection, $isRangeSelection, FORMAT_TEXT_COMMAND, type EditorState, type LexicalEditor } from 'lexical';
import { LexicalTypeaheadMenuPlugin, MenuOption, useBasicTypeaheadTriggerMatch } from '@lexical/react/LexicalTypeaheadMenuPlugin';
import { $createHeadingNode, $createQuoteNode } from '@lexical/rich-text';
import { $createCodeNode } from '@lexical/code';
import { $setBlocksType } from '@lexical/selection';
import { $getNearestNodeOfType } from '@lexical/utils';

const URL_MATCHER = createLinkMatcherWithRegExp(/((https?:\/\/(www\.)?)|(www\.))[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,12}\b([-a-zA-Z0-9()@:%_+.~#?&//=]*)/, (t) =>
  t.startsWith('http') ? t : `https://${t}`,
);
const EMAIL_MATCHER = createLinkMatcherWithRegExp(/[\w.+-]+@[\w-]+\.[\w.-]+/, (t) => `mailto:${t}`);

const theme = {
  paragraph: 'rn-p',
  link: 'rn-link',
  list: { ul: 'rn-ul', ol: 'rn-ol', listitem: 'rn-li', nested: { listitem: 'rn-nested' } },
  heading: { h1: 'rn-h', h2: 'rn-h', h3: 'rn-h' },
  quote: 'rn-quote',
  code: 'rn-code',
  text: { bold: 'rn-b', italic: 'rn-i', strikethrough: 'rn-s', code: 'rn-icode', underline: 'rn-u' },
};

interface Props {
  value: string;
  readOnly?: boolean;
  placeholder?: string;
  /** Called with markdown when editing pauses or the editor loses focus. */
  onSave(markdown: string): void;
}

/**
 * Bold / italic / link / lists, floating over the selected text (like
 * Notion or Medium). Positioned inside the notes box, so it scrolls with it.
 */
function FloatingBar({ box }: { box: RefObject<HTMLDivElement | null> }) {
  const [editor] = useLexicalComposerContext();
  const [state, setState] = useState({ bold: false, italic: false, ul: false, ol: false, link: false });
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    const update = () =>
      editor.getEditorState().read(() => {
        const sel = $getSelection();
        const dom = window.getSelection();
        if (!$isRangeSelection(sel) || sel.isCollapsed() || !dom || dom.rangeCount === 0 || !box.current || !editor.isEditable()) return setPos(null);
        const r = dom.getRangeAt(0).getBoundingClientRect();
        const b = box.current.getBoundingClientRect();
        if (!r.width && !r.height) return setPos(null);
        setPos({ left: Math.max(0, Math.min(b.width - 180, r.left - b.left + r.width / 2 - 90)), top: r.top - b.top - 40 });
        const node = sel.anchor.getNode();
        const list = $getNearestNodeOfType(node, ListNode);
        setState({
          bold: sel.hasFormat('bold'),
          italic: sel.hasFormat('italic'),
          ul: $isListNode(list) && list.getListType() === 'bullet',
          ol: $isListNode(list) && list.getListType() === 'number',
          link: $isLinkNode(node.getParent()) || $isLinkNode(node),
        });
      });
    const off = editor.registerUpdateListener(update);
    // Selecting with the mouse doesn't always change the editor state.
    document.addEventListener('selectionchange', update);
    return () => {
      off();
      document.removeEventListener('selectionchange', update);
    };
  }, [editor, box]);
  if (!pos) return null;
  const btn = (on: boolean, label: string, title: string, run: () => void, cls = '') => (
    <button
      type="button"
      className={'rn-btn' + (on ? ' on' : '') + cls}
      title={title}
      aria-label={title}
      aria-pressed={on}
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
    >
      {label}
    </button>
  );
  return (
    <div className="rn-bar floating" role="toolbar" aria-label="Formatting" style={{ left: pos.left, top: pos.top }}>
      {btn(state.bold, 'B', 'Bold (⌘B)', () => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold'), ' b')}
      {btn(state.italic, 'I', 'Italic (⌘I)', () => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'italic'), ' i')}
      {btn(state.link, '↗', 'Link', () => {
        if (state.link) editor.dispatchCommand(TOGGLE_LINK_COMMAND, null);
        else {
          const url = prompt('Link to');
          if (url) editor.dispatchCommand(TOGGLE_LINK_COMMAND, /^[a-z]+:/i.test(url) ? url : `https://${url}`);
        }
      })}
      <span className="rn-sep" />
      {btn(state.ul, '•', 'Bulleted list', () => editor.dispatchCommand(state.ul ? REMOVE_LIST_COMMAND : INSERT_UNORDERED_LIST_COMMAND, undefined))}
      {btn(state.ol, '1.', 'Numbered list', () => editor.dispatchCommand(state.ol ? REMOVE_LIST_COMMAND : INSERT_ORDERED_LIST_COMMAND, undefined))}
    </div>
  );
}

// --- "/" menu: turn the current line into a list, heading, quote… -----------------------

class SlashOption extends MenuOption {
  constructor(
    readonly name: string,
    readonly glyph: string,
    readonly keywords: string[],
    readonly run: (editor: LexicalEditor) => void,
  ) {
    super(name);
  }
}

const block = (create: () => ReturnType<typeof $createParagraphNode> | ReturnType<typeof $createHeadingNode>) => () => {
  const sel = $getSelection();
  if ($isRangeSelection(sel)) $setBlocksType(sel, create);
};

const SLASH: SlashOption[] = [
  new SlashOption('Text', '¶', ['paragraph', 'plain'], () => block($createParagraphNode)()),
  new SlashOption('Heading', 'H', ['title', 'h2'], () => block(() => $createHeadingNode('h2'))()),
  new SlashOption('Small heading', 'h', ['subtitle', 'h3'], () => block(() => $createHeadingNode('h3'))()),
  new SlashOption('Bulleted list', '•', ['ul', 'unordered', 'bullet'], (e) => e.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined)),
  new SlashOption('Numbered list', '1.', ['ol', 'ordered', 'number'], (e) => e.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined)),
  new SlashOption('Quote', '“', ['blockquote', 'citation'], () => {
    const sel = $getSelection();
    if ($isRangeSelection(sel)) $setBlocksType(sel, () => $createQuoteNode());
  }),
  new SlashOption('Code', '<>', ['snippet', 'pre'], () => {
    const sel = $getSelection();
    if ($isRangeSelection(sel)) $setBlocksType(sel, () => $createCodeNode());
  }),
];

function SlashMenu() {
  const [editor] = useLexicalComposerContext();
  const [query, setQuery] = useState<string | null>(null);
  const trigger = useBasicTypeaheadTriggerMatch('/', { minLength: 0 });
  const options = useMemo(() => {
    const q = (query ?? '').toLowerCase();
    return SLASH.filter((o) => !q || o.name.toLowerCase().includes(q) || o.keywords.some((k) => k.startsWith(q)));
  }, [query]);
  return (
    <LexicalTypeaheadMenuPlugin<SlashOption>
      onQueryChange={setQuery}
      triggerFn={trigger}
      options={options}
      anchorClassName="rn-slash-anchor"
      onSelectOption={(option, textNode, close) => {
        editor.update(() => {
          textNode?.remove();
          option.run(editor);
          close();
        });
      }}
      menuRenderFn={(anchor, { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex }) =>
        anchor.current && options.length
          ? createPortal(
              // .ui-pop: a click in here isn't "outside" the task panel.
              <div className="rn-slash ui-pop" role="listbox" aria-label="Insert">
                {options.map((o, i) => (
                  <div
                    key={o.key}
                    ref={o.setRefElement}
                    role="option"
                    aria-selected={i === selectedIndex}
                    className={'rn-slash-item' + (i === selectedIndex ? ' on' : '')}
                    onMouseEnter={() => setHighlightedIndex(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => selectOptionAndCleanUp(o)}
                  >
                    <span className="rn-slash-icon">{o.glyph}</span>
                    {o.name}
                  </div>
                ))}
              </div>,
              anchor.current,
            )
          : null
      }
    />
  );
}

/** Follow outside changes (another person editing) while not focused. */
function SyncValue({ value, focused }: { value: string; focused: boolean }) {
  const [editor] = useLexicalComposerContext();
  const last = useRef(value);
  useEffect(() => {
    if (focused || value === last.current) return;
    last.current = value;
    editor.update(() => $convertFromMarkdownString(value, TRANSFORMERS, undefined, true));
  }, [value, focused, editor]);
  return null;
}

export default function RichNotes({ value, readOnly, placeholder = 'Notes  ·  type / for lists and headings', onSave }: Props) {
  const [focused, setFocused] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const flush = () => {
    clearTimeout(timer.current);
    if (pending.current !== null && pending.current !== value) onSave(pending.current);
    pending.current = null;
  };
  // Save what's typed when the panel closes.
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => () => flushRef.current(), []);

  const onChange = (state: EditorState) => {
    const md = state.read(() => $convertToMarkdownString(TRANSFORMERS, undefined, true));
    if (md === value) return;
    pending.current = md;
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, 1200);
  };

  return (
    <LexicalComposer
      initialConfig={{
        namespace: 'notes',
        theme,
        editable: !readOnly,
        nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode, LinkNode, AutoLinkNode, CodeNode],
        editorState: () => $convertFromMarkdownString(value, TRANSFORMERS, undefined, true),
        onError: (e) => console.error(e),
      }}
    >
      <div
        ref={box}
        className={'rich-notes' + (focused ? ' focused' : '') + (readOnly ? ' readonly' : '')}
        onFocus={() => setFocused(true)}
        onBlur={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node)) return;
          setFocused(false);
          flush();
        }}
      >
        {focused && !readOnly && <FloatingBar box={box} />}
        <RichTextPlugin
          contentEditable={<ContentEditable className="rn-editable" aria-label="Notes" aria-placeholder={placeholder} placeholder={<div className="rn-placeholder">{placeholder}</div>} />}
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <ListPlugin />
        <LinkPlugin />
        <AutoLinkPlugin matchers={[URL_MATCHER, EMAIL_MATCHER]} />
        <ClickableLinkPlugin newTab />
        <MarkdownShortcutPlugin transformers={TRANSFORMERS} />
        {!readOnly && <SlashMenu />}
        <OnChangePlugin onChange={onChange} ignoreSelectionChange />
        <SyncValue value={value} focused={focused} />
      </div>
    </LexicalComposer>
  );
}
