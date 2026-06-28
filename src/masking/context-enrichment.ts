import type { PlaceholderContext } from './context';
import type { OpenAIMessage } from '../providers/openai/types';

interface EntityConfig {
  description: string;
  fields: Record<string, string>;
  prefix_chars?: number;
  suffix_chars?: number;
}

interface EnrichmentConfig {
  enabled: boolean;
  system_prompt: string;
  entities: Record<string, EntityConfig>;
  default: EntityConfig;
}

/**
 * Evaluate template variables for a single placeholder
 */
function evaluateTemplate(
  template: string,
  originalValue: string,
  entityType: string,
  score: number,
  entityConfig: EntityConfig,
): string {
  const prefixLen = entityConfig.prefix_chars ?? 0;
  const suffixLen = entityConfig.suffix_chars ?? 0;

  const replacements: Record<string, string> = {
    '{{length}}': String(originalValue.length),
    '{{word_count}}': String(originalValue.split(/\s+/).filter(Boolean).length),
    '{{type}}': entityType,
    '{{score}}': score.toFixed(2),
    '{{domain}}': originalValue.includes('@')
      ? originalValue.split('@')[1] ?? ''
      : '',
    '{{initials}}': originalValue
      .split(/\s/)
      .filter(Boolean)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .join(''),
    '{{prefix}}': originalValue.slice(0, prefixLen),
    '{{suffix}}': originalValue.slice(-suffixLen),
    '{{char_set}}': [
      /[a-zA-Z]/.test(originalValue) ? 'letters' : '',
      /[0-9]/.test(originalValue) ? 'digits' : '',
      /[^a-zA-Z0-9\s]/.test(originalValue) ? 'symbols' : '',
    ]
      .filter(Boolean)
      .join(', '),
  };

  let result = template;
  for (const [key, value] of Object.entries(replacements)) {
    result = result.replaceAll(key, value);
  }

  // Handle {{slice:START:END}} - extract substring
  result = result.replace(/\{\{slice:(-?\d+):(-?\d+)\}\}/g, (_, startStr, endStr) => {
    const start = parseInt(startStr, 10);
    const end = parseInt(endStr, 10);
    const len = originalValue.length;
    const s = start < 0 ? Math.max(0, len + start) : Math.min(start, len - 1);
    const e = end < 0 ? Math.max(0, len + end) : Math.min(end, len - 1);
    return originalValue.slice(s, e + 1);
  });

  return result;
}

/**
 * Build metadata block for all masked entities
 */
export function buildMetadataBlock(
  context: PlaceholderContext,
  config: EnrichmentConfig,
): string {
  const placeholders = Object.keys(context.mapping);
  if (placeholders.length === 0) return '';

  const lines: string[] = [];

  for (const placeholder of placeholders) {
    const entityType = context.entityTypes[placeholder] ?? 'UNKNOWN';
    const originalValue = context.mapping[placeholder];
    const score = context.scores[placeholder] ?? 1.0;

    const entityConfig = config.entities[entityType] ?? config.default;

    const description = evaluateTemplate(
      entityConfig.description,
      originalValue,
      entityType,
      score,
      entityConfig,
    );

    lines.push(`${placeholder} = ${description}`);

    if (entityConfig.fields) {
      for (const [fieldName, fieldTemplate] of Object.entries(entityConfig.fields)) {
        const fieldValue = evaluateTemplate(
          fieldTemplate,
          originalValue,
          entityType,
          score,
          entityConfig,
        );
        lines.push(`  ${fieldName}: ${fieldValue}`);
      }
    }

    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Inject metadata as a system message into the request
 */
export function injectMetadataSystemMessage<TRequest>(
  request: TRequest,
  context: PlaceholderContext,
  enrichmentConfig: EnrichmentConfig,
  format: 'openai' | 'anthropic',
): TRequest {
  if (!enrichmentConfig.enabled) return request;

  const entitiesBlock = buildMetadataBlock(context, enrichmentConfig);
  if (!entitiesBlock) return request;

  const systemText = enrichmentConfig.system_prompt.replace(
    '{{entities}}',
    entitiesBlock,
  );

  const req = request as any;

  if (format === 'openai') {
    const hasSystem = req.messages.some(
      (m: any) => m.role === 'system',
    );

    if (hasSystem) {
      const idx = req.messages.findIndex(
        (m: any) => m.role === 'system',
      );
      const existing = req.messages[idx].content;
      req.messages[idx] = {
        ...req.messages[idx],
        content: systemText + '\n\n' + (typeof existing === 'string' ? existing : ''),
      };
    } else {
      req.messages = [
        { role: 'system', content: systemText },
        ...req.messages,
      ];
    }
  }

  if (format === 'anthropic') {
    if (req.system) {
      if (typeof req.system === 'string') {
        req.system = systemText + '\n\n' + req.system;
      } else if (Array.isArray(req.system)) {
        req.system = [
          { type: 'text', text: systemText },
          ...req.system,
        ];
      }
    } else {
      req.system = systemText;
    }
  }

  return request;
}
