import { LogRecord, Env, AlertRule } from './types';

// In-memory cooldown tracker to prevent alert spamming (keyed by rule_id:service)
const cooldownMap = new Map<string, number>();

// In-memory timestamps for sliding window spike detection
const recentErrorTimestamps: number[] = [];

export const DEFAULT_ALERT_RULES: AlertRule[] = [
  {
    id: 'panic_fatal',
    name: 'Panic / Fatal Application Crash',
    severity: 'critical',
    trigger: (log) =>
      log.level === 'fatal' ||
      log.level === 'panic' ||
      (typeof log.message === 'string' && (log.message.includes('panic:') || log.message.includes('FATAL:'))),
  },
  {
    id: 'database_error',
    name: 'Database Connection / Query Failure',
    severity: 'critical',
    trigger: (log) => {
      const msg = typeof log.message === 'string' ? log.message : '';
      return (
        msg.includes('pq: ') ||
        msg.includes('connection refused') ||
        msg.includes('connection pool exhausted') ||
        msg.includes('database is locked') ||
        msg.includes('SQLSTATE')
      );
    },
  },
  {
    id: 'http_5xx',
    name: 'Internal Server Error (5xx)',
    severity: 'warning',
    trigger: (log) => {
      const status = typeof log.status === 'number' ? log.status : 0;
      return status >= 500 || log.level === 'error';
    },
  },
  {
    id: 'latency_spike',
    name: 'High Latency Spike (>3,000ms)',
    severity: 'warning',
    trigger: (log) => typeof log.duration_ms === 'number' && log.duration_ms > 3000,
  },
];

export async function processAlerts(logs: LogRecord[], env: Env, host: string): Promise<void> {
  const cooldownSec = parseInt(env.ALERT_COOLDOWN_SECONDS || '300', 10);
  const now = Date.now();

  for (const log of logs) {
    // 1. Sliding window rate check for any error
    if (log.level === 'error' || log.level === 'fatal' || (log.status && log.status >= 500)) {
      recentErrorTimestamps.push(now);
    }

    // 2. Evaluate rules
    for (const rule of DEFAULT_ALERT_RULES) {
      if (rule.trigger(log)) {
        const cooldownKey = `${rule.id}:${log.service || 'unknown'}`;
        const lastSent = cooldownMap.get(cooldownKey) || 0;

        if (now - lastSent > cooldownSec * 1000) {
          cooldownMap.set(cooldownKey, now);
          await dispatchAlert(rule, log, env, host);
        }
      }
    }
  }

  // 3. Check for sliding window error spike (>5 errors in 10 seconds)
  const tenSecAgo = now - 10000;
  while (recentErrorTimestamps.length > 0 && recentErrorTimestamps[0] < tenSecAgo) {
    recentErrorTimestamps.shift();
  }

  if (recentErrorTimestamps.length >= 6) {
    const spikeCooldownKey = 'error_spike_global';
    const lastSpikeSent = cooldownMap.get(spikeCooldownKey) || 0;

    if (now - lastSpikeSent > cooldownSec * 1000) {
      cooldownMap.set(spikeCooldownKey, now);
      await dispatchSpikeAlert(recentErrorTimestamps.length, env, host);
    }
  }
}

async function dispatchAlert(rule: AlertRule, log: LogRecord, env: Env, host: string): Promise<void> {
  const icon = rule.severity === 'critical' ? '🚨' : '⚠️';
  const traceUrl = log.trace_id ? `https://${host}/?trace_id=${log.trace_id}` : `https://${host}/`;

  const title = `${icon} [FlareLens] ${rule.name}`;
  const details = [
    `• Service: \`${log.service || 'app'}\``,
    `• Level: \`${(log.level || 'info').toUpperCase()}\``,
    log.duration_ms ? `• Latency: \`${log.duration_ms}ms\`` : '',
    log.status ? `• Status: \`${log.status}\`` : '',
    `• Message: \`${(log.message || '').slice(0, 300)}\``,
    log.trace_id ? `• Trace: [Inspect Waterfall 🔍](${traceUrl})` : '',
  ]
    .filter(Boolean)
    .join('\n');

  // Telegram Alert
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    try {
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text: `*${title}*\n\n${details}`,
          parse_mode: 'Markdown',
          disable_web_page_preview: false,
        }),
      });
    } catch (e) {
      console.error('Failed to send Telegram alert:', e);
    }
  }

  // Slack Alert
  if (env.SLACK_WEBHOOK_URL) {
    try {
      await fetch(env.SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `${title}\n${details.replace(/`/g, '')}`,
        }),
      });
    } catch (e) {
      console.error('Failed to send Slack alert:', e);
    }
  }

  // Discord Alert
  if (env.DISCORD_WEBHOOK_URL) {
    try {
      await fetch(env.DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: `**${title}**\n${details}`,
        }),
      });
    } catch (e) {
      console.error('Failed to send Discord alert:', e);
    }
  }

  // WhatsApp Alert (Meta Cloud API or Twilio)
  await sendWhatsApp(
    `*${title}*\n\n${details.replace(/`/g, '')}`,
    env
  );
}

/**
 * Sends a WhatsApp notification via Meta WhatsApp Cloud API or Twilio WhatsApp API
 */
async function sendWhatsApp(bodyText: string, env: Env): Promise<void> {
  // 1. Meta WhatsApp Cloud API (Official)
  if (env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_TO) {
    try {
      const cleanTo = env.WHATSAPP_TO.replace(/[^\d]/g, '');
      await fetch(`https://graph.facebook.com/v21.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: cleanTo,
          type: 'text',
          text: {
            preview_url: true,
            body: bodyText,
          },
        }),
      });
    } catch (e) {
      console.error('Failed to send Meta WhatsApp alert:', e);
    }
  }

  // 2. Twilio WhatsApp API (Alternative)
  if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_WHATSAPP_TO) {
    try {
      const auth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
      const fromNumber = env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';
      const toNumber = env.TWILIO_WHATSAPP_TO.startsWith('whatsapp:')
        ? env.TWILIO_WHATSAPP_TO
        : `whatsapp:${env.TWILIO_WHATSAPP_TO}`;

      const params = new URLSearchParams();
      params.append('From', fromNumber);
      params.append('To', toNumber);
      params.append('Body', bodyText);

      await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });
    } catch (e) {
      console.error('Failed to send Twilio WhatsApp alert:', e);
    }
  }
}

async function dispatchSpikeAlert(count: number, env: Env, host: string): Promise<void> {
  const text = `🚨 *[FlareLens] CRITICAL ERROR SPIKE DETECTED*\n\n• Received *${count} errors* in the last 10 seconds across services.\n• Check live dashboard immediately: https://${host}/`;

  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    try {
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text,
          parse_mode: 'Markdown',
        }),
      });
    } catch (e) {
      console.error('Failed to dispatch spike alert to Telegram:', e);
    }
  }

  // Dispatch spike to WhatsApp
  await sendWhatsApp(text, env);
}
