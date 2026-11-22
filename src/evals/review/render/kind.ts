import type { FailureMode } from '../../registry/schema.js';
import type { ReviewBatch, ReviewDecision, ReviewItem } from '../batch.js';

export type Choice = { decision: ReviewDecision; key: string; label: string; needsValue?: boolean };
export type RenderContext = { mode?: FailureMode };

/** One page kind: its decisions and how an item reads. Items are rendered from public fields only. */
export interface KindRenderer {
    choices: Choice[];
    /** One-key reasons a reviewer can attach to a decision. */
    reasons?: Array<{ key: string; id: string; label: string }>;
    /** The judged values need the width: the evidence docks only on a wide screen, and is a drawer otherwise. */
    wide?: boolean;
    header?(batch: ReviewBatch, ctx: RenderContext): string;
    item(item: ReviewItem): string;
    /** Strips what the reviewer must not see (blind kinds). */
    publicItem?(item: ReviewItem): ReviewItem;
}
