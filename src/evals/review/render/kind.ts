import type { FailureMode } from '../../registry/schema.js';
import type { ReviewBatch, ReviewDecision, ReviewItem } from '../batch.js';

export type Choice = { decision: ReviewDecision; key: string; label: string; needsValue?: boolean };
export type RenderContext = { mode?: FailureMode };

/** One page kind: its decisions and how an item reads. Items are rendered from public fields only. */
export interface KindRenderer {
    choices: Choice[];
    header?(batch: ReviewBatch, ctx: RenderContext): string;
    item(item: ReviewItem): string;
    /** Strips what the reviewer must not see (blind kinds). */
    publicItem?(item: ReviewItem): ReviewItem;
}
