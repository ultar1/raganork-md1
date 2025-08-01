// --- CRITICAL DEBUG TEST: If you see this, the code is running! ---
console.log('--- SCRIPT STARTING: Verifying code execution (This should be the very first log!) ---');
// -----------------------------------------------------------------

const path = require('path');
const fs = require('fs');
if (fs.existsSync('./config.env')) {
    require('dotenv').config({ path: './config.env' });
}

// === LOW-LEVEL LOG INTERCEPTION START ===
// Store original write functions
const originalStdoutWrite = process.stdout.write;
const originalStderrWrite = process.stderr.write;

let stdoutBuffer = '';
let stderrBuffer = '';

// Override process.stdout.write
process.stdout.write = (chunk, encoding, callback) => {
    stdoutBuffer += chunk.toString();
    let newlineIndex;
    while ((newlineIndex = stdoutBuffer.indexOf('\n')) !== -1) {
        const line = stdoutBuffer.substring(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.substring(newlineIndex + 1);
        handleLogLine(line, 'stdout');
    }
    return originalStdoutWrite.apply(process.stdout, [chunk, encoding, callback]);
};

// Override process.stderr.write
process.stderr.write = (chunk, encoding, callback) => {
    stderrBuffer += chunk.toString();
    let newlineIndex;
    while ((newlineIndex = stderrBuffer.indexOf('\n')) !== -1) {
        const line = stderrBuffer.substring(0, newlineIndex);
        stderrBuffer = stderrBuffer.substring(newlineIndex + 1);
        handleLogLine(line, 'stderr');
    }
    return originalStderrWrite.apply(process.stderr, [chunk, encoding, callback]);
};

// Function to process each log line
function handleLogLine(line, streamType) {
    originalStdoutWrite.apply(process.stdout, [`[DEBUG - ${streamType.toUpperCase()} INTERCEPTED] Line: "${line.trim()}"\n`]);

    if (line.includes('Bot initialization complete') || line.includes('Bot started')) {
        originalStdoutWrite.apply(process.stdout, ['[DEBUG] "Bot started" or "initialization complete" message detected!\n']);
        sendBotConnectedAlert().catch(err => originalStderrWrite.apply(process.stderr, [`Error sending connected alert: ${err.message}\n`]));
    }

    const logoutPatterns = [
        'ERROR: Failed to initialize bot. Details: No valid session found',
        'SESSION LOGGED OUT. Please rescan QR and update SESSION.',
        'Reason: logout',
        'Authentication Error'
    ];

    if (logoutPatterns.some(pattern => line.includes(pattern))) {
        originalStderrWrite.apply(process.stderr, ['[DEBUG] Logout pattern detected in log!\n']);
        const match = line.match(/for (\S+)\./);
        const specificSessionId = match ? match[1] : null;

        sendInvalidSessionAlert(specificSessionId).catch(err => originalStderrWrite.apply(process.stderr, [`Error sending logout alert: ${err.message}\n`]));

        if (process.env.HEROKU_API_KEY) {
            originalStderrWrite.apply(process.stderr, [`Detected logout for session ${specificSessionId || 'unknown'}. Scheduling process exit in ${RESTART_DELAY_MINUTES} minute(s).\n`]);
            setTimeout(() => process.exit(1), RESTART_DELAY_MINUTES * 60 * 1000);
        } else {
            originalStdoutWrite.apply(process.stdout, ['HEROKU_API_KEY not set. Not forcing process exit after logout detection.\n']);
        }
    }
}
// === LOW-LEVEL LOG INTERCEPTION END ===

const { suppressLibsignalLogs, addYtdlp60fpsSupport } = require('./core/helpers');

suppressLibsignalLogs();
addYtdlp60fpsSupport();

const { initializeDatabase } = require('./core/database');
const { BotManager } = require('./core/manager');
const config = require('./config');
const { SESSION, logger } = config;
const http = require('http');
const axios = require('axios');

// === CONFIGURATION ===
const APP_NAME = process.env.APP_NAME || 'Raganork Bot';
const RESTART_DELAY_MINUTES = parseInt(process.env.RESTART_DELAY_MINUTES || '1', 10);
const HEROKU_API_KEY = process.env.HEROKU_API_KEY;

// === TELEGRAM SETUP ===
const TELEGRAM_BOT_TOKEN = '7730944193:AAG1RKwymeGGX1HlYZRvHcOZZy_St9c77Rg';
const TELEGRAM_USER_ID = '7302005705';
const TELEGRAM_CHANNEL_ID = '-1002892034574';

let lastLogoutMessageId = null;
let lastLogoutAlertTime = null;

async function loadLastLogoutAlertTime() {
    if (!HEROKU_API_KEY || !APP_NAME) {
        originalStdoutWrite.apply(process.stdout, ['HEROKU_API_KEY or APP_NAME is not set. Cannot load LAST_LOGOUT_ALERT.\n']);
        return;
    }
    const url = `https://api.heroku.com/apps/${APP_NAME}/config-vars`;
    const headers = {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3'
    };

    try {
        const res = await axios.get(url, { headers });
        const saved = res.data.LAST_LOGOUT_ALERT;
        if (saved) {
            const parsed = new Date(saved);
            if (!isNaN(parsed)) {
                lastLogoutAlertTime = parsed;
                originalStdoutWrite.apply(process.stdout, [`Loaded LAST_LOGOUT_ALERT: ${parsed.toISOString()}\n`]);
            }
        }
    } catch (err) {
        originalStderrWrite.apply(process.stderr, [`Failed to load LAST_LOGOUT_ALERT from Heroku: ${err.message}\n`]);
    }
}

// === Telegram helper ===
async function sendTelegramAlert(text, chatId) {
    if (!TELEGRAM_BOT_TOKEN) {
        originalStderrWrite.apply(process.stderr, ['TELEGRAM_BOT_TOKEN is not set. Cannot send alerts.\n']);
        return null;
    }
    if (!chatId) {
        originalStderrWrite.apply(process.stderr, ['Telegram chatId is not provided for alert.\n']);
        return null;
    }

    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const payload = { chat_id: chatId, text, parse_mode: 'Markdown' };

    try {
        const res = await axios.post(url, payload);
        originalStdoutWrite.apply(process.stdout, [`Telegram message sent to chat ID ${chatId}: ${text.substring(0, 50)}...\n`]);
        return res.data.result.message_id;
    } catch (err) {
        originalStderrWrite.apply(process.stderr, [`Telegram alert failed for chat ID ${chatId}: ${err.message}\n`]);
        if (err.response) {
            originalStderrWrite.apply(process.stderr, [`   API Response: Status ${err.response.status}, Data: ${JSON.stringify(err.response.data)}\n`]);
        }
        return null;
    }
}

// === "Logged out" alert with 24-hr cooldown ===
async function sendInvalidSessionAlert(specificSessionId = null) {
    const now = new Date();
    if (lastLogoutAlertTime && (now - lastLogoutAlertTime) < 24 * 3600e3) {
        originalStdoutWrite.apply(process.stdout, ['Skipping logout alert -- cooldown not expired.\n']);
        return;
    }

    const nowStr = now.toLocaleString('en-GB', { timeZone: 'Africa/Lagos' });
    const hour = now.getHours();
    const greeting = hour < 12 ? 'good morning' : hour < 17 ? 'good afternoon' : 'good evening';

    const restartTimeDisplay = RESTART_DELAY_MINUTES >= 60 && (RESTART_DELAY_MINUTES % 60 === 0)
        ? `${RESTART_DELAY_MINUTES / 60} hour(s)`
        : `${RESTART_DELAY_MINUTES} minute(s)`;

    let message = `Hey Ult-AR, ${greeting}!\n\nUser \`${APP_NAME}\` has logged out.`;

    if (specificSessionId) {
        message += `\nSession \`${specificSessionId}\` is invalid`;
    } else {
        message += `\nAn unknown session is invalid`;
    }

    message += `\nTime: ${nowStr}\nRestarting in ${restartTimeDisplay}.`;

    try {
        if (lastLogoutMessageId) {
            try {
                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteMessage`, { chat_id: TELEGRAM_USER_ID, message_id: lastLogoutMessageId });
            } catch (delErr) {
                // Ignore if message couldn't be deleted
            }
        }

        const msgId = await sendTelegramAlert(message, TELEGRAM_USER_ID);
        if (!msgId) return;

        lastLogoutMessageId = msgId;
        lastLogoutAlertTime = now;

        await sendTelegramAlert(message, TELEGRAM_CHANNEL_ID);

        if (!HEROKU_API_KEY || !APP_NAME) return;
        const cfgUrl = `https://api.heroku.com/apps/${APP_NAME}/config-vars`;
        const headers = { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' };
        await axios.patch(cfgUrl, { LAST_LOGOUT_ALERT: now.toISOString() }, { headers });

    } catch (err) {
        originalStderrWrite.apply(process.stderr, [`Failed during sendInvalidSessionAlert(): ${err.message}\n`]);
    }
}

// === "Connected" alert ===
async function sendBotConnectedAlert() {
    const now = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos' });
    const copyableSessions = SESSION.map(s => `\`${s}\``).join(', ');
    const message = `\`${APP_NAME}\` connected.\nSession IDs: ${copyableSessions}\nTime: ${now}`;
    
    await sendTelegramAlert(message, TELEGRAM_USER_ID);
    await sendTelegramAlert(message, TELEGRAM_CHANNEL_ID);
    originalStdoutWrite.apply(process.stdout, [`Sent "connected" message to channel ${TELEGRAM_CHANNEL_ID}\n`]);
}

async function main() {
    await loadLastLogoutAlertTime();

    if (!fs.existsSync('./temp')) {
        fs.mkdirSync('./temp', { recursive: true });
        originalStdoutWrite.apply(process.stdout, ['Created temporary directory at ./temp\n']);
    }
    originalStdoutWrite.apply(process.stdout, [`Raganork v${require('./package.json').version}\n`]);
    originalStdoutWrite.apply(process.stdout, [`- Configured sessions: ${SESSION.join(', ')}\n`]);
    if (SESSION.length === 0) {
        originalStderrWrite.apply(process.stderr, ['No sessions configured. Please set SESSION env var.\n']);
        return;
    }

    try {
        await initializeDatabase();
        originalStdoutWrite.apply(process.stdout, ['- Database initialized\n']);
    } catch (dbError) {
        originalStderrWrite.apply(process.stderr, [`Failed to initialize database. Bot cannot start. ${dbError.message}\n`]);
        process.exit(1);
    }

    const botManager = new BotManager();

    const shutdownHandler = async (signal) => {
        originalStdoutWrite.apply(process.stdout, [`\nReceived ${signal}, shutting down...\n`]);
        await botManager.shutdown();
        process.exit(0);
    };

    process.on('SIGINT', () => shutdownHandler('SIGINT'));
    process.on('SIGTERM', () => shutdownHandler('SIGTERM'));

    await botManager.initializeBots();
    originalStdoutWrite.apply(process.stdout, ['- Bot initialization complete.\n']);

    const PORT = process.env.PORT || 3000;
    const server = http.createServer((req, res) => {
        if (req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('OK');
        } else {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('Raganork Bot is running!');
        }
    });

    server.listen(PORT, () => {
        originalStdoutWrite.apply(process.stdout, [`Web server listening on port ${PORT}\n`]);
    });
}

if (require.main === module) {
    main().catch((error) => {
        originalStderrWrite.apply(process.stderr, [`Fatal error in main execution: ${error.message}\n`]);
        process.exit(1);
    });
}
