// The reader's note back to the sender: one quiet "Comment" under each section
// heading, and one box at the end of the deck for the document as a whole.
//
// NOTHING IS EVER READ BACK. A reader never sees anyone else's comment, and
// not their own after a reload — this is a note to the sender, not a thread.
// That is also why there is no edit and no delete: there is nothing on screen
// to edit, and the sender was told the moment it was sent.
//
// Every node lives behind a closed shadow root on a host carrying
// TRACKER_UI_ATTR. The shadow root is what keeps the deck's CSS out of our box
// and our CSS out of the deck; the attribute is what keeps the box out of the
// section tracker's measurements (see rangeMembers and pickCandidates in
// sections-v2.ts). Both matter: this runs inside somebody else's document.

import { TRACKER_UI_ATTR, type SectionAnchor } from './sections-v2.js';

/** Matches MAX_COMMENT_CHARS in packages/db/src/public.ts, which trims past it. */
const MAX_CHARS = 2000;

export interface CommentDraft {
  sectionId: string | null;
  sectionTitle: string | null;
  body: string;
}

export interface CommentsOptions {
  /** The sections to hang an affordance off, from the section tracker. */
  anchors: SectionAnchor[];
  /**
   * Sends one comment. Resolves with null when it is stored, or with a line to
   * show the reader — same contract as the e-mail gate's `attempt`, so a
   * refusal from the worker is surfaced instead of failing behind a closed UI.
   */
  send: (draft: CommentDraft) => Promise<string | null>;
}

// Written once and shared by every root. `all: initial` on the host is the
// same trick the e-mail gate uses: the deck cannot style what it cannot reach,
// and an inherited font-size from a `.slide { font-size: 3vw }` cannot blow
// the box up.
const CSS = `:host{all:initial;display:block;margin:8px 0;font:400 13px/1.5 -apple-system,BlinkMacSystemFont,'Inter',system-ui,sans-serif;color:#3A2818}
button{font:inherit;cursor:pointer;border:1px solid #E8D5BD;border-radius:6px;background:#FBF1E8;color:#7A1F2E;padding:4px 10px}
button:hover{background:#F4E1CB}
button:disabled{opacity:.5;cursor:default}
:focus-visible{outline:2px solid #7A1F2E;outline-offset:2px}
.open{padding:2px 8px;font-size:11.5px;opacity:.7}
.open:hover{opacity:1}
form{margin:0;max-width:34em}
label{display:block;margin-bottom:4px;font-size:11.5px;color:#876959}
textarea{display:block;box-sizing:border-box;width:100%;min-height:4.5em;padding:8px 10px;font:inherit;color:#1F1108;background:#fff;border:1px solid #E8D5BD;border-radius:6px;resize:vertical}
.row{display:flex;align-items:center;gap:8px;margin-top:6px}
.send{background:#7A1F2E;border-color:#7A1F2E;color:#FBF1E8}
.send:hover{background:#63161F}
.msg{font-size:11.5px;color:#876959}
.err{font-size:11.5px;color:#B35314}
[hidden]{display:none}`;

const SENT = 'Sent to the sender.';

// The box at the end is open on arrival — a reader who scrolled that far has
// finished, and one more click to say so is one too many. A section's box is
// behind its button, because eight open textareas down a deck is a form, not
// a document.
function template(prompt: string, openOnArrival: boolean): string {
  return `<style>${CSS}</style>
${openOnArrival ? '' : '<button type="button" class="open">Comment</button>'}
<form${openOnArrival ? '' : ' hidden'} novalidate>
  <label for="hr-c">${prompt}</label>
  <textarea id="hr-c" maxlength="${MAX_CHARS}" rows="3"></textarea>
  <div class="row">
    <button type="submit" class="send">Send</button>
    ${openOnArrival ? '' : '<button type="button" class="cancel">Cancel</button>'}
    <span class="msg">Only the sender sees this.</span>
  </div>
  <div class="err" role="alert"></div>
</form>
<div class="done msg" role="status" hidden>${SENT}</div>`;
}

function mountOne(
  host: HTMLElement,
  prompt: string,
  openOnArrival: boolean,
  target: { sectionId: string | null; sectionTitle: string | null },
  send: CommentsOptions['send'],
): void {
  host.setAttribute(TRACKER_UI_ATTR, 'comment');
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = template(prompt, openOnArrival);

  const open = root.querySelector<HTMLButtonElement>('.open');
  const form = root.querySelector<HTMLFormElement>('form')!;
  const input = root.querySelector<HTMLTextAreaElement>('textarea')!;
  const error = root.querySelector<HTMLElement>('.err')!;
  const done = root.querySelector<HTMLElement>('.done')!;
  const submit = root.querySelector<HTMLButtonElement>('.send')!;
  const cancel = root.querySelector<HTMLButtonElement>('.cancel');

  const show = (formVisible: boolean): void => {
    form.hidden = !formVisible;
    if (open) open.hidden = formVisible;
    if (formVisible) input.focus();
    else open?.focus();
  };
  open?.addEventListener('click', () => show(true));
  cancel?.addEventListener('click', () => show(false));
  // Escape closes what a click opened, and only that: a box the reader never
  // opened has no state to lose, and Escape belongs to the deck.
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) {
      e.stopPropagation();
      show(false);
    }
  });
  input.addEventListener('input', () => {
    error.textContent = '';
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = input.value.trim();
    if (!body) {
      error.textContent = 'Write something first.';
      input.focus();
      return;
    }
    submit.disabled = true;
    submit.textContent = 'Sending…';
    error.textContent = '';
    const failure = await send({ ...target, body });
    if (failure) {
      submit.disabled = false;
      submit.textContent = 'Send';
      error.textContent = failure;
      return;
    }
    // Quietly done: the form goes, one line stays. Nothing is echoed back,
    // because what is on screen would then be the one copy the reader could
    // not correct, and the sender already has theirs.
    form.remove();
    if (open) open.remove();
    done.hidden = false;
  });
}

export function mountComments(opts: CommentsOptions): void {
  for (const anchor of opts.anchors) {
    const host = document.createElement('span');
    anchor.element.insertAdjacentElement('afterend', host);
    // The title is a snapshot taken now, so a comment carries the heading the
    // reader was looking at even after the deck is replaced.
    mountOne(
      host,
      'Your comment on this section',
      false,
      { sectionId: anchor.id, sectionTitle: anchor.title },
      opts.send,
    );
  }
  const tail = document.createElement('div');
  document.body.appendChild(tail);
  mountOne(
    tail,
    'Anything to tell the sender about this document?',
    true,
    { sectionId: null, sectionTitle: null },
    opts.send,
  );
}
