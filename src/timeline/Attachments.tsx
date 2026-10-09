import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { addAttachment, newId, removeAttachment, store, type AttachmentRow } from '../data/store.ts';
import { formatBytes, loadFile, MAX_FILE_BYTES, saveFile, SHEET_FILES_BYTES } from '../data/files.ts';
import { shrinkImage } from '../lib/images.ts';
import { Close, External, FileIcon, LinkIcon, Paperclip } from '../ui/icons.tsx';

type Item = AttachmentRow & { id: string };

// Bumped on any attachment change (registered before any component listens).
let changes = 0;
store.addTableListener('attachments', () => void changes++);
const getChanges = () => changes;

/** Live list of a task's attachments, oldest first. */
const useAttachments = (taskId: string): Item[] => {
  const subscribe = useCallback((fn: () => void) => {
    const l = store.addTableListener('attachments', fn);
    return () => void store.delListener(l);
  }, []);
  const version = useSyncExternalStore(subscribe, getChanges);
  return useMemo(
    () =>
      store
        .getRowIds('attachments')
        .map((id) => ({ id, ...(store.getRow('attachments', id) as AttachmentRow) }))
        .filter((a) => a.taskId === taskId)
        .sort((a, b) => a.created - b.created),
    [taskId, version],
  );
};

const extOf = (name: string) => (name.includes('.') ? name.split('.').pop()!.toUpperCase().slice(0, 4) : '');
const hostOf = (url: string) => {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
};
const normalizeUrl = (raw: string) => {
  const s = raw.trim();
  if (!s) return '';
  return /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
};

/** The plan's uploaded files, together. */
const filesBytes = () =>
  store.getRowIds('attachments').reduce((n, id) => n + (store.getCell('attachments', id, 'kind') === 'file' ? Number(store.getCell('attachments', id, 'size') ?? 0) : 0), 0);

/** Attach files (from a picker, drop or paste) to a task. */
export const attachFiles = async (taskId: string, files: Iterable<File>): Promise<string | null> => {
  for (const original of files) {
    const f = await shrinkImage(original);
    if (f.size > MAX_FILE_BYTES) return `${f.name} is larger than ${formatBytes(MAX_FILE_BYTES)}.`;
    if (filesBytes() + f.size > SHEET_FILES_BYTES)
      return `This plan’s files are full (${formatBytes(SHEET_FILES_BYTES)}). Remove some you no longer need, or attach a link instead.`;
    const id = newId();
    await saveFile(id, f);
    addAttachment({ taskId, kind: 'file', name: f.name || 'Pasted file', url: '', mime: f.type, size: f.size }, id);
  }
  return null;
};

function Thumb({ item }: { item: Item }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (item.kind !== 'file' || !item.mime.startsWith('image/')) return;
    let url: string | null = null;
    let alive = true;
    loadFile(item.id).then((b) => {
      if (b && alive) setSrc((url = URL.createObjectURL(b)));
    });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [item.id, item.kind, item.mime]);
  if (src) return <img className="att-thumb" src={src} alt="" />;
  return (
    <span className={'att-thumb icon' + (item.kind === 'link' ? ' link' : '')}>
      {item.kind === 'link' ? <LinkIcon /> : extOf(item.name) || <FileIcon />}
    </span>
  );
}

const PREVIEWABLE = /^(image\/|video\/|audio\/|text\/|application\/pdf)/;

export function Attachments({ taskId, onError }: { taskId: string; onError(msg: string): void }) {
  const items = useAttachments(taskId);
  const [linking, setLinking] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const linkInput = useRef<HTMLInputElement>(null);

  const open = async (a: Item) => {
    if (a.kind === 'link') {
      window.open(a.url, '_blank', 'noopener');
      return;
    }
    // Open the tab inside the click so popup blockers allow it.
    const win = PREVIEWABLE.test(a.mime) ? window.open('', '_blank') : null;
    const blob = await loadFile(a.id);
    if (!blob) {
      win?.close();
      onError('This file is only on the device that attached it.');
      return;
    }
    const url = URL.createObjectURL(blob);
    if (win) win.location.href = url;
    else {
      const el = document.createElement('a');
      el.href = url;
      el.download = a.name;
      el.click();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const addLink = () => {
    const url = normalizeUrl(linkInput.current?.value ?? '');
    if (!url) return setLinking(false);
    addAttachment({ taskId, kind: 'link', name: hostOf(url), url, mime: '', size: 0 });
    setLinking(false);
  };

  return (
    <div className="atts">
      <div className="atts-head">
        <span className="atts-label">Attachments{items.length ? <b>{items.length}</b> : null}</span>
        <button className="chipbtn" onMouseDown={(e) => e.preventDefault()} onClick={() => fileInput.current?.click()}>
          <Paperclip size={14} /> File
        </button>
        <button
          className="chipbtn"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setLinking(true);
            requestAnimationFrame(() => linkInput.current?.focus());
          }}
        >
          <LinkIcon size={14} /> Link
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={async (e) => {
            const files = [...(e.currentTarget.files ?? [])];
            e.currentTarget.value = '';
            const err = await attachFiles(taskId, files);
            if (err) onError(err);
          }}
        />
      </div>
      {linking && (
        <div className="att-link-form">
          <input
            ref={linkInput}
            type="url"
            inputMode="url"
            placeholder="Paste a link (Figma, Docs, ticket…)"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addLink();
              } else if (e.key === 'Escape') {
                e.stopPropagation();
                setLinking(false);
              }
            }}
          />
          <button className="btn primary" onClick={addLink}>
            Add
          </button>
        </div>
      )}
      {items.length > 0 && (
        <ul className="att-list">
          {items.map((a) => (
            <li key={a.id} className="att">
              <button className="att-main" onClick={() => open(a)} title={a.kind === 'link' ? a.url : `Open ${a.name}`}>
                <Thumb item={a} />
                <span className="att-text">
                  <span className="att-name">{a.name}</span>
                  <span className="att-meta">
                    {a.kind === 'link' ? (
                      <>
                        Link <External size={11} />
                      </>
                    ) : (
                      `${formatBytes(a.size)}${extOf(a.name) ? ` · ${extOf(a.name)}` : ''}`
                    )}
                  </span>
                </span>
              </button>
              <button className="att-remove" aria-label={`Remove ${a.name}`} onClick={() => removeAttachment(a.id)}>
                <Close size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
