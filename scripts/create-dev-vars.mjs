import { randomBytes } from 'node:crypto';
import { writeFileSync, existsSync } from 'node:fs';

const token = randomBytes(32).toString('hex');
const content = `# Local development secrets for Wrangler dev.\n# Do NOT commit real tokens. This file is already ignored by .gitignore.\n# Cloudflare docs: https://developers.cloudflare.com/workers/wrangler/configuration/#secrets\n\nAPP_TOKEN=${token}\nAI_MODEL=@cf/meta/llama-3.1-8b-instruct\nDEFAULT_MAX_RISK_PERCENT=1\nDEFAULT_MIN_CONFIDENCE=65\n`;

if (existsSync('.dev.vars')) {
  console.error('.dev.vars already exists. Delete it first if you want to regenerate token.');
  process.exit(1);
}

writeFileSync('.dev.vars', content);
console.log('Created .dev.vars with a new APP_TOKEN.');
console.log('Use the same APP_TOKEN in the UI Settings and MT5 EA input InpAppToken.');
