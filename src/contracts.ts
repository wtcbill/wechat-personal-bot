/**
 * L3 — Channel-neutral text contracts.
 * Input/Output: owner identity, inbound text and opaque reply handles.
 * Pos: shared application/channel contracts; see ./L2.md.
 * Effects/Dependencies: none; no protocol or model SDK dependencies.
 */
export interface InboundText {
  id: string;
  senderId: string;
  text: string;
  replyHandle: string;
}

export interface TextChannel {
  // null ends a finite input stream; an empty batch keeps polling.
  receive(signal: AbortSignal): Promise<InboundText[] | null>;
  sendReply(replyHandle: string, text: string, signal: AbortSignal): Promise<SendReceipt>;
  release(replyHandle: string): void;
  checkpoint(): Promise<void>;
}

// Submission/acknowledgement is distinct from the user's confirmation of delivery.
export interface SendReceipt { status: "accepted" | "submitted" }

export type Log = (event: string) => void;
