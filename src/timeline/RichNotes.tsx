// Rich-text task notes (Lexical). Stored as markdown in the task's `notes`
// cell, so plain notes (and Teamweek imports with "- " lists and bare links)
// open as formatted text, and the CRDT still merges a plain string.
//
// Loaded on demand (see Editor.tsx) to keep Lexical out of the first paint.

import { useEffect, useRef, useState } from 'react';
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
import { $getSelection, $isRangeSelection, FORMAT_TEXT_COMMAND, type EditorState } from 'lexical';
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

/** Bold / italic / lists / link, shown while the notes are being edited. */
function FormatBar() {
  const [editor] = useLexicalComposerContext();
  const [state, setState] = useState({ bold: false, italic: false, ul: false, ol: false, link: false });
  // Reflect the formatting at the cursor.
  useEffect(
    () =>
      editor.registerUpdateListener(({ editorState }) =>
        editorState.read(() => {
          const sel = $getSelection();
          if (!$isRangeSelection(sel)) return;
          const node = sel.anchor.getNode();
          const list = $getNearestNodeOfType(node, ListNode);
          setState({
            bold: sel.hasFormat('bold'),
            italic: sel.hasFormat('italic'),
            ul: $isListNode(list) && list.getListType() === 'bullet',
            ol: $isListNode(list) && list.getListType() === 'number',
            link: $isLinkNode(node.getParent()) || $isLinkNode(node),
          });
        }),
      ),
    [editor],
  );
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
    <div className="rn-bar" role="toolbar" aria-label="Formatting">
      {btn(state.bold, 'B', 'Bold (⌘B)', () => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold'), ' b')}
      {btn(state.italic, 'I', 'Italic (⌘I)', () => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'italic'), ' i')}
      {btn(state.ul, '•', 'Bulleted list', () => editor.dispatchCommand(state.ul ? REMOVE_LIST_COMMAND : INSERT_UNORDERED_LIST_COMMAND, undefined))}
      {btn(state.ol, '1.', 'Numbered list', () => editor.dispatchCommand(state.ol ? REMOVE_LIST_COMMAND : INSERT_ORDERED_LIST_COMMAND, undefined))}
      {btn(state.link, '↗', 'Link', () => {
        if (state.link) editor.dispatchCommand(TOGGLE_LINK_COMMAND, null);
        else {
          const url = prompt('Link to');
          if (url) editor.dispatchCommand(TOGGLE_LINK_COMMAND, /^[a-z]+:/i.test(url) ? url : `https://${url}`);
        }
      })}
    </div>
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

export default function RichNotes({ value, readOnly, placeholder = 'Notes', onSave }: Props) {
  const [focused, setFocused] = useState(false);
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
        className={'rich-notes' + (focused ? ' focused' : '') + (readOnly ? ' readonly' : '')}
        onFocus={() => setFocused(true)}
        onBlur={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node)) return;
          setFocused(false);
          flush();
        }}
      >
        {focused && !readOnly && <FormatBar />}
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
        <OnChangePlugin onChange={onChange} ignoreSelectionChange />
        <SyncValue value={value} focused={focused} />
      </div>
    </LexicalComposer>
  );
}
