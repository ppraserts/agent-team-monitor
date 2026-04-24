// Parser for the <<PROPOSAL>>...<<END_PROPOSAL>> approval-protocol blocks
// emitted by agents that have require_approval enabled.
//
// We accept any whitespace around the markers and extract the body verbatim;
// the renderer is responsible for further formatting (e.g. fenced code blocks).

export interface Proposal {
  /// Index of this proposal within the parent message (for stable decision keys).
  index: number;
  /// Verbatim body between the markers.
  body: string;
  /// Char index of `<<PROPOSAL>>` in the original text.
  start: number;
  /// Char index just past `<<END_PROPOSAL>>` in the original text.
  end: number;
}

const RE = /<<PROPOSAL>>([\s\S]*?)<<END_PROPOSAL>>/g;

export function parseProposals(text: string): Proposal[] {
  const out: Proposal[] = [];
  let m: RegExpExecArray | null;
  let i = 0;
  RE.lastIndex = 0;
  while ((m = RE.exec(text)) !== null) {
    out.push({
      index: i++,
      body: m[1].trim(),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

/// Strip every <<PROPOSAL>>...<<END_PROPOSAL>> block from the text, leaving
/// only the agent's narrative prose. Used so the chat bubble doesn't
/// duplicate what the proposal card already shows.
export function stripProposals(text: string): string {
  return text.replace(RE, "").trim();
}

/// Pull the first ```bash``` (or ```sh```) fenced block out of a proposal
/// body so we can render it as a distinct command box. Returns the rest of
/// the body as `description`.
export function splitProposalBody(
  body: string,
): { description: string; command: string | null } {
  const fence = /```(?:bash|sh|shell|powershell|ps1|cmd)?\n?([\s\S]*?)```/;
  const m = body.match(fence);
  if (!m) {
    return { description: body.trim(), command: null };
  }
  const description = (body.slice(0, m.index!) + body.slice(m.index! + m[0].length))
    .trim();
  return { description, command: m[1].trim() };
}

export function decisionKey(messageId: string, proposalIndex: number): string {
  return `${messageId}#${proposalIndex}`;
}
