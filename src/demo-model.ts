/**
 * A scripted stand-in for Claude, enabled only with AGENT_MODEL=demo. It lets reviewers
 * without an API key run the whole pipeline: the job queue, the real tools against the
 * real database, guardrails, proposals and approvals. It does not reason. It picks tools
 * by keyword, and every answer it gives says it came from the demo model.
 *
 * It returns the same BetaMessage shapes as the API, so the agent loop runs unchanged.
 */
import type {
  BetaContentBlock,
  BetaMessage,
  BetaMessageParam,
  BetaToolResultBlockParam,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages';
import type { ModelClient } from './agent.js';

export const DEMO_MODEL = 'demo';

type ToolCall = { name: string; input: Record<string, unknown> };
type Results = Array<{ name: string; ok: boolean; content: unknown }>;

function message(content: BetaContentBlock[], stop: BetaMessage['stop_reason']): BetaMessage {
  return {
    id: `demo_${Math.random().toString(36).slice(2)}`,
    type: 'message',
    role: 'assistant',
    model: DEMO_MODEL,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  } as BetaMessage;
}

const callTools = (calls: ToolCall[]) =>
  message(
    calls.map(
      (c, i) =>
        ({ type: 'tool_use', id: `toolu_demo_${Date.now()}_${i}`, name: c.name, input: c.input }) as BetaContentBlock,
    ),
    'tool_use',
  );

const answer = (text: string) =>
  message([{ type: 'text', text: `[demo model] ${text}`, citations: null } as BetaContentBlock], 'end_turn');

/** The turn's user question and the tool results that came back since. */
function turn(messages: BetaMessageParam[]): {
  question: string;
  today: string;
  rounds: Results[];
  calls: ToolCall[][];
} {
  let start = messages.length - 1;
  while (start >= 0) {
    const m = messages[start];
    if (m?.role === 'user' && typeof m.content === 'string') break;
    start--;
  }
  const raw = String(messages[start]?.content ?? '');
  const today = /\[today: (\d{4}-\d{2}-\d{2})\]/.exec(raw)?.[1] ?? new Date().toISOString().slice(0, 10);
  const rounds: Results[] = [];
  const calls: ToolCall[][] = [];
  for (const m of messages.slice(start + 1)) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      calls.push(
        m.content
          .filter((b) => b.type === 'tool_use')
          .map((b) => ({ name: (b as { name: string }).name, input: (b as { input: Record<string, unknown> }).input })),
      );
    }
    if (m.role === 'user' && Array.isArray(m.content)) {
      const names = calls.at(-1) ?? [];
      rounds.push(
        (m.content as BetaToolResultBlockParam[]).map((r, i) => {
          const text = typeof r.content === 'string' ? r.content : '';
          let content: unknown = text;
          try {
            content = JSON.parse(text);
          } catch {}
          return { name: names[i]?.name ?? '?', ok: !r.is_error, content };
        }),
      );
    }
  }
  return { question: raw.replace(/^\[today: [^\]]+\]\n/, ''), today, rounds, calls };
}

const daysBefore = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

type Campaign = { id: string; name: string; daily_budget: number; status: string };

export const demoModel: ModelClient = async (params: MessageCreateParamsNonStreaming) => {
  const { question, today, rounds } = turn(params.messages);
  const q = question.toLocaleLowerCase('tr');
  const last = rounds.at(-1);

  // Every scenario that names a campaign starts by listing them, like a real analyst would.
  if (!rounds.length) {
    if (/bozul|anomal|ne değişti|what changed/.test(q)) {
      return callTools([
        { name: 'detect_anomalies', input: { metric: 'ctr', recent_days: 7, baseline_days: 28, threshold_pct: 40 } },
      ]);
    }
    if (/roas/.test(q)) {
      return callTools([
        {
          name: 'get_performance',
          input: { campaign_ids: null, date_from: daysBefore(today, 6), date_to: today, group_by: 'campaign' },
        },
      ]);
    }
    return callTools([{ name: 'list_campaigns', input: { status: 'all' } }]);
  }

  const first = rounds[0]?.[0];
  if (first?.name === 'detect_anomalies') {
    const rows = (
      first.content as { anomalies: Array<{ name: string; change_pct: number; recent: number; baseline: number }> }
    ).anomalies;
    if (!rows.length) return answer('Son 7 günde CTR açısından belirgin bir sapma yok.');
    const a = rows[0];
    return answer(
      `"${a?.name}" kampanyasında son 7 günde CTR %${a?.recent} ile önceki 28 günün ortalamasına (%${a?.baseline}) göre %${Math.abs(a?.change_pct ?? 0)} düştü. Kreatif yorgunluğu olabilir; yeni kreatif denemenizi öneririm.`,
    );
  }
  if (first?.name === 'get_performance') {
    const rows = (first.content as { rows: Array<{ name: string; roas: number | null }> }).rows
      .filter((r) => r.roas !== null)
      .sort((x, y) => (y.roas ?? 0) - (x.roas ?? 0));
    return answer(`Son 7 günde ROAS'ı en yüksek kampanya "${rows[0]?.name}" (ROAS ${rows[0]?.roas}).`);
  }

  // Scenarios that act on a named campaign.
  const campaigns = ((first?.content as { campaigns?: Campaign[] })?.campaigns ?? []) as Campaign[];
  const target = campaigns
    .filter((c) => q.includes(c.name.toLocaleLowerCase('tr')))
    .sort((x, y) => y.name.length - x.name.length)[0];
  if (!target) {
    const active = campaigns.filter((c) => c.status === 'active').length;
    return answer(
      `Hesapta ${campaigns.length} kampanya var, ${active} tanesi aktif. Hangi kampanyayı incelememi istersiniz?`,
    );
  }

  if (/durdur|pause/.test(q)) {
    if (rounds.length === 1) {
      return callTools([
        {
          name: 'propose_action',
          input: {
            kind: 'pause_campaign',
            campaign_id: target.id,
            new_daily_budget: null,
            reason: 'Kullanıcı durdurulmasını istedi; harcama dönüşüm getirmiyor.',
          },
        },
      ]);
    }
    const r = last?.[0];
    return r?.ok
      ? answer(
          `"${target.name}" için durdurma önerisi oluşturdum (id ${(r.content as { action_id: string }).action_id}). Onayladığınızda uygulanacak.`,
        )
      : answer(`Öneri oluşturulamadı: ${r?.content}`);
  }

  if (/bütçe|budget/.test(q)) {
    const factor = /3 kat|üç kat|triple|3x/.test(q) ? 3 : 1.2;
    if (rounds.length === 1) {
      return callTools([
        {
          name: 'propose_action',
          input: {
            kind: 'change_budget',
            campaign_id: target.id,
            new_daily_budget: Math.round(target.daily_budget * factor),
            reason: 'Kullanıcı bütçe artışı istedi.',
          },
        },
      ]);
    }
    const r = last?.[0];
    if (rounds.length === 2 && !r?.ok) {
      // The guardrail rejected the request; propose the largest allowed change instead.
      return callTools([
        {
          name: 'propose_action',
          input: {
            kind: 'change_budget',
            campaign_id: target.id,
            new_daily_budget: Math.round(target.daily_budget * 1.5),
            reason: 'İstenen artış ±%50 sınırını aşıyor; izin verilen en yüksek artış önerildi.',
          },
        },
      ]);
    }
    return answer(
      rounds.length === 3
        ? `${target.daily_budget} TL'den ${Math.round(target.daily_budget * factor)} TL'ye çıkarmak ±%50 kuralına takıldı. Bunun yerine ${Math.round(target.daily_budget * 1.5)} TL (+%50) önerisi oluşturdum; onayınızı bekliyor.`
        : `Bütçe önerisi oluşturuldu ve onayınızı bekliyor.`,
    );
  }

  return answer(`"${target.name}": günlük bütçe ${target.daily_budget} TL, durum ${target.status}.`);
};
