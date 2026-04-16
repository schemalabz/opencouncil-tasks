import { TopicLabelInfo } from "../types.js";

export function formatTopicLabels(labels: TopicLabelInfo[]): string {
  return labels.map(t =>
    t.description ? `- ${t.name} — ${t.description}` : `- ${t.name}`
  ).join('\n');
}
