# Valetax MT5 AI Bot + Cloudflare Workers AI

Project ini berisi scaffold aplikasi trading teknis:

- **Mobile UI HTML**: `public/index.html`
- **Cloudflare Worker API + Workers AI binding**: `src/worker.js`
- **MT5 Expert Advisor (EA)**: `mql5/ValetaxCloudflareAIBot.mq5`
- **MT5 Account Guard / Login metadata** di UI: nomor login + server, tanpa password
- **Deploy config**: `wrangler.toml`

> Penting: ini bukan nasihat finansial dan tidak menjamin profit. Selalu uji di akun demo terlebih dahulu, gunakan risk management, dan pahami bahwa auto trading berisiko kehilangan dana.

## Arsitektur

Browser HTML tidak bisa mengeksekusi order langsung ke MT5/Valetax. Alur yang benar:

1. UI mobile menyimpan pengaturan dan dapat mengirim data indikator ke Worker.
2. UI juga menyimpan metadata login MT5 Valetax secara lokal: nomor login, server, tipe akun. Password broker tidak pernah disimpan.
3. Cloudflare Worker menjalankan 5 agent scoring:
   - Trend Agent
   - Momentum Agent
   - Volatility Agent
   - Price Action Agent
   - Risk Guard Agent
3. Jika Workers AI binding aktif, Worker meminta AI melakukan consensus konservatif.
4. EA MT5 membaca indikator dari chart Valetax MT5, memanggil endpoint `/api/signal`, lalu mengeksekusi order jika `InpAllowAutoTrade=true`.

## Deploy ke Cloudflare

### 1. Install dependency

```bash
npm install
```

### 2. Login Cloudflare

```bash
npx wrangler login
```

### 3. Set token rahasia

```bash
npm run cf:secret
# isi APP_TOKEN, contoh: token panjang acak
```

`APP_TOKEN` harus sama dengan input di UI dan EA.

### 4. Deploy

```bash
npm run deploy
```

Setelah deploy, buka URL Worker yang diberikan Wrangler.

## Development lokal

```bash
npm run dev
```

Buka URL lokal Wrangler. Jika belum ada Workers AI binding lokal, API tetap memakai fallback weighted-vote.

## Endpoint penting

### Health

```http
GET /api/health
```

### Analyze dari UI

```http
POST /api/analyze
x-app-token: APP_TOKEN
content-type: application/json

{
  "symbol": "XAUUSD",
  "price": 4448.98,
  "emaFast": 4455,
  "emaSlow": 4448,
  "rsi": 62,
  "atrPoints": 250,
  "spreadPoints": 20,
  "candleDir": "bullish",
  "riskPercent": 1,
  "minConfidence": 65
}
```

### Quote harga referensi untuk UI

```http
GET /api/quote?symbol=XAUUSD&token=APP_TOKEN
```

Endpoint ini mengambil harga referensi dari Stooq CSV untuk mengisi kolom Price di UI. Harga broker Valetax/MT5 bisa berbeda karena spread dan likuiditas. EA tetap memakai bid/ask langsung dari terminal MT5.

### Signal untuk EA

```http
GET /api/signal?symbol=XAUUSD&price=4448.98&emaFast=4455&emaSlow=4448&rsi=62&atrPoints=250&spreadPoints=20&candleDir=bullish&token=APP_TOKEN
```

Response ringkas untuk EA:

```json
{
  "ok": true,
  "symbol": "XAUUSD",
  "action": "buy",
  "direction": "bullish",
  "confidence": 72,
  "slPoints": 375,
  "tpPoints": 563,
  "maxSpreadPoints": 35,
  "reason": "Weighted 5-agent vote..."
}
```

## Login Akun MT5 Valetax

Aplikasi web tidak melakukan login broker secara langsung. Login trading harus dilakukan di terminal MT5 Valetax:

1. Buka MT5 Valetax.
2. Pilih `File -> Login to Trade Account`.
3. Masukkan nomor login, password, dan server dari Valetax langsung di MT5.
4. Di UI aplikasi, buka menu **Login Akun MT5** lalu isi:
   - Nomor Login MT5
   - Server MT5 Valetax
   - Tipe akun demo/live
5. Copy konfigurasi input EA dari UI.

EA memiliki guard berikut:

```text
InpExpectedAccountLogin=nomor_login_anda
InpExpectedAccountServer=server_valetax_anda
InpRequireAccountMatch=true
```

Jika akun MT5 yang sedang aktif tidak cocok, EA akan berhenti / tidak trading. Ini mencegah bot berjalan di akun yang salah.

> Jangan simpan password broker di HTML, Worker, GitHub, atau file project. Password hanya dimasukkan di terminal MT5 resmi.

## Instal EA di MT5 Valetax

1. Buka MT5 yang sudah login ke akun Valetax.
2. `File -> Open Data Folder`.
3. Copy `mql5/ValetaxCloudflareAIBot.mq5` ke `MQL5/Experts/`.
4. Buka MetaEditor, compile file tersebut.
5. Di MT5: `Tools -> Options -> Expert Advisors`:
   - centang `Allow algorithmic trading`
   - centang `Allow WebRequest for listed URL`
   - tambahkan URL Worker Cloudflare, contoh `https://valetax-mt5-ai-bot.username.workers.dev`
6. Attach EA ke chart symbol yang akan diperdagangkan.
7. Input:
   - `InpWorkerUrl`: URL Worker
   - `InpAppToken`: token yang sama dengan `APP_TOKEN`
   - `InpExpectedAccountLogin`: nomor login MT5 Valetax Anda
   - `InpExpectedAccountServer`: server MT5 Valetax Anda
   - `InpRequireAccountMatch`: `true` agar EA hanya jalan di akun yang benar
   - `InpAllowAutoTrade`: mulai dari `false`; ubah `true` hanya setelah demo test
   - risk, max spread, min confidence, dll.

## Bagian yang masih perlu Anda lengkapi sebelum live

- Forward test demo dan backtest terpisah.
- Daily loss limit dan max open trades per akun (bisa ditambah ke EA).
- VPS untuk MT5 agar EA berjalan stabil 24/5.
- Monitoring log Cloudflare dan MT5.
- Domain custom + TLS default Cloudflare.
- Alert Telegram/Discord untuk sinyal dan order.
- Proteksi token lebih kuat jika banyak user: JWT, Cloudflare Access, D1/KV untuk user settings.
- Kalender news/high-impact filter agar EA tidak trade saat volatilitas ekstrem.

## Catatan keamanan

- Jangan simpan password broker atau investor password di HTML/Worker/localStorage/GitHub.
- Menu Login Akun MT5 hanya menyimpan nomor login dan server untuk validasi EA, bukan password.
- EA berjalan di terminal MT5 yang sudah login; Worker hanya memberi sinyal.
- Jangan expose `APP_TOKEN` ke publik.
- Gunakan akun demo sampai statistik stabil.
