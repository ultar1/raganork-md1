// --- CRITICAL DEBUG TEST: If you see this, the code is running! ---
console.log('--- SCRIPT STARTING: Verifying code execution (This should be the very first log!) ---');
// -----------------------------------------------------------------

const path = require("path");
const fs = require("fs");
if (fs.existsSync("./config.env")) {
    require("dotenv").config({ path: "./config.env" });
}

// === LOW-LEVEL LOG INTERCEPTION START ===
// Store original write functions
const originalStdoutWrite = process.stdout.write;
const originalStderrWrite = process.stderr.write;

// Buffer for collecting output before processing
let stdoutBuffer = '';
let stderrBuffer = '';

// Override process.stdout.write
process.stdout.write = (chunk, encoding, callback) => {
    stdoutBuffer += chunk.toString();
    // Process line by line
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
    // Process line by line
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
    // This console.log will go to original stdout/stderr, avoiding recursion
    // originalStdoutWrite.apply(process.stdout, [`[DEBUG - ${streamType.toUpperCase()} INTERCEPTED] Line: "${line.trim()}"\n`]);

    // Check for 'Bot started' message
    if (line.includes('Bot initialization complete') || line.includes('Bot started')) {
        originalStdoutWrite.apply(process.stdout, ['[DEBUG] "Bot started" or "initialization complete" message detected!\n']);
        // Call the alert function (needs to be defined after imports)
        sendBotConnectedAlert().catch(err => originalStderrWrite.apply(process.stderr, [`Error sending connected alert: ${err.message}\n`]));
    }

    // --- 💡 NEW: Check for Data Transfer Quota Exceeded 💡 ---
    if (line.includes('Your project has exceeded the data transfer quota')) {
        originalStderrWrite.apply(process.stderr, ['[DEBUG] NEON DATA QUOTA EXCEEDED detected!\n']);
        
        const alertMsg = `**NEON QUOTA EXCEEDED**\n\nApp: \`${APP_NAME}\`\nError: Data transfer quota exceeded. Database is likely offline.`;
        
        // FIX: Send to CHANNEL ID instead of Admin ID
        sendTelegramAlert(alertMsg, TELEGRAM_CHANNEL_ID).catch(err => originalStderrWrite.apply(process.stderr, [`Error sending quota alert: ${err.message}\n`]));
    }
    // --- 💡 END OF NEW CHECK 💡 ---

    // Check for logout patterns
    const logoutPatterns = [
        'ERROR: Failed to initialize bot. Details: No valid session found',
        'SESSION LOGGED OUT. Please rescan QR and update SESSION.',
        'Reason: logout',
        'Authentication Error',
        'ERROR: Max reconnection attempts reached. Stopping reconnection.'
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


const { suppressLibsignalLogs } = require("./core/helpers");
const { initializeDatabase } = require("./core/database");
const { BotManager } = require("./core/manager");
const config = require("./config");
const { SESSION, logger } = config;
const http = require("http");
const axios = require('axios'); // Added axios for Telegram API calls

// === CONFIGURATION ===
const APP_NAME = process.env.APP_NAME || 'Levanter Bot';
const RESTART_DELAY_MINUTES = parseInt(process.env.RESTART_DELAY_MINUTES || '1', 10);
const HEROKU_API_KEY = process.env.HEROKU_API_KEY;

// === TELEGRAM SETUP - HARDCODED ===
const TELEGRAM_BOT_TOKEN = '8445525121:AAHptKLywJtFSh6w2CXVYC2Esza6PhAAAnQ'; // Your Token
const TELEGRAM_USER_ID = '7302005705';
const TELEGRAM_CHANNEL_ID = '-1003620973489';

let lastLogoutMessageId = null;
let lastLogoutAlertTime = null;

// === Load LAST_LOGOUT_ALERT from Heroku config vars ===
async function loadLastLogoutAlertTime() {
    if (!HEROKU_API_KEY || !APP_NAME) {
        originalStdoutWrite.apply(process.stdout, ['HEROKU_API_KEY or APP_NAME is not set. Cannot load LAST_LOGOUT_ALERT from Heroku config vars.\n']);
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
async function sendTelegramAlert(text, chatId) { // chatId is now required
    if (!TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN === 'YOUR_NEW_VALID_TOKEN_GOES_HERE') { 
        originalStderrWrite.apply(process.stderr, ['TELEGRAM_BOT_TOKEN is not set. Cannot send Telegram alerts.\n']);
        return null;
    }
    if (!chatId) {
        originalStderrWrite.apply(process.stderr, ['Telegram chatId is not provided for alert. Cannot send.\n']);
        return null;
    }

    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const payload = { chat_id: chatId, text, parse_mode: 'Markdown' }; // Added parse_mode for bold text

    try {
        const res = await axios.post(url, payload);
        originalStdoutWrite.apply(process.stdout, [`Telegram message sent to chat ID ${chatId}: ${text.substring(0, 50)}...\n`]);
        return res.data.result.message_id;
    } catch (err) {
        originalStderrWrite.apply(process.stderr, [`Telegram alert failed for chat ID ${chatId}: ${err.message}\n`]);
        return null;
    }
}

// === "Logged out" alert with 24-hr cooldown & auto-delete ===
async function sendInvalidSessionAlert(specificSessionId = null) {
    const now = new Date();
    if (lastLogoutAlertTime && (now - lastLogoutAlertTime) < 24 * 3600e3) {
        originalStdoutWrite.apply(process.stdout, ['Skipping logout alert -- cooldown not expired.\n']);
        return;
    }

    const nowStr = now.toLocaleString('en-GB', { timeZone: 'Africa/Lagos' });
    const hour = now.getHours();
    const greeting = hour < 12 ? 'good morning'
        : hour < 17 ? 'good afternoon'
            : 'good evening';

    const restartTimeDisplay = RESTART_DELAY_MINUTES >= 60 && (RESTART_DELAY_MINUTES % 60 === 0)
        ? `${RESTART_DELAY_MINUTES / 60} hour(s)`
        : `${RESTART_DELAY_MINUTES} minute(s)`;

    // FIX CONFIRMED: Brackets are correctly included here.
    let message =
        `Hey Ult-AR, ${greeting}!\n\n` +
        `User [${APP_NAME}] has logged out.`; // This line ensures the brackets [APP_NAME] are present.

    if (specificSessionId) {
        message += `\n[${specificSessionId}] invalid`;
    } else {
        message += `\n[UNKNOWN_SESSION] invalid`; 
    }

    message += `\nTime: ${nowStr}\n` +
        `Restarting in ${restartTimeDisplay}.`;

    try {
        if (lastLogoutMessageId) {
            try {
                await axios.post(
                    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteMessage`,
                    { chat_id: TELEGRAM_USER_ID, message_id: lastLogoutMessageId }
                );
            } catch (delErr) { /* ignore */ }
        }

        const msgId = await sendTelegramAlert(message, TELEGRAM_USER_ID);
        if (!msgId) return;

        lastLogoutMessageId = msgId;
        lastLogoutAlertTime = now;

        await sendTelegramAlert(message, TELEGRAM_CHANNEL_ID);
        originalStdoutWrite.apply(process.stdout, [`Sent new logout alert to channel ${TELEGRAM_CHANNEL_ID}\n`]);

        if (!HEROKU_API_KEY || !APP_NAME) {
            originalStdoutWrite.apply(process.stdout, ['HEROKU_API_KEY or APP_NAME is not set. Cannot persist LAST_LOGOUT_ALERT timestamp.\n']);
            return;
        }
        const cfgUrl = `https://api.heroku.com/apps/${APP_NAME}/config-vars`;
        const headers = {
            Authorization: `Bearer ${HEROKU_API_KEY}`,
            Accept: 'application/vnd.heroku+json; version=3',
            'Content-Type': 'application/json'
        };
        await axios.patch(cfgUrl, { LAST_LOGOUT_ALERT: now.toISOString() }, { headers });
        originalStdoutWrite.apply(process.stdout, [`Persisted LAST_LOGOUT_ALERT timestamp.\n`]);
    } catch (err) {
        originalStderrWrite.apply(process.stderr, [`Failed during sendInvalidSessionAlert(): ${err.message}\n`]);
    }
}

// Function to handle bot connected messages
async function sendBotConnectedAlert() {
    const now = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos' });
    const message = `[${APP_NAME}] connected.\nSession IDs: ${SESSION.join(', ')}\nTime: ${now}`;
    await sendTelegramAlert(message, TELEGRAM_USER_ID);
    await sendTelegramAlert(message, TELEGRAM_CHANNEL_ID);
    originalStdoutWrite.apply(process.stdout, [`Sent "connected" message to channel ${TELEGRAM_CHANNEL_ID}\n`]);
}


async function main() {
    await loadLastLogoutAlertTime();

    if (!fs.existsSync("./temp")) {
        fs.mkdirSync("./temp", { recursive: true });
        originalStdoutWrite.apply(process.stdout, ["Created temporary directory at ./temp\n"]);
    }
    originalStdoutWrite.apply(process.stdout, [`Raganork v${require("./package.json").version}\n`]);
    originalStdoutWrite.apply(process.stdout, [`- Configured sessions: ${SESSION.join(", ")}\n`]);

    if (SESSION.length === 0) {
        const warnMsg =
            "⚠️ No sessions configured. Please set SESSION environment variable.";
        originalStderrWrite.apply(process.stderr, [`${warnMsg}\n`]);
        return;
    }

    try {
        await initializeDatabase();
        originalStdoutWrite.apply(process.stdout, ["- Database initialized\n"]);
    } catch (dbError) {
        originalStderrWrite.apply(process.stderr, [`Failed to initialize database or load configuration. Bot cannot start. ${dbError.message}\n`]);
        process.exit(1);
    }

    const botManager = new BotManager();

    const shutdownHandler = async (signal) => {
        originalStdoutWrite.apply(process.stdout, [`\nReceived ${signal}, shutting down...\n`]);
        await botManager.shutdown();
        process.exit(0);
    };

    process.on("SIGINT", () => shutdownHandler("SIGINT"));
    process.on("SIGTERM", () => shutdownHandler("SIGTERM"));

    await botManager.initializeBots();
    originalStdoutWrite.apply(process.stdout, ["- Bot initialization complete.\n"]);

    const PORT = process.env.PORT || 3000;

    const server = http.createServer((req, res) => {
        if (req.url === "/health") {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("OK");
        } else {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("Raganork Bot is running!");
        }
    });

    server.listen(PORT, () => {
        originalStdoutWrite.apply(process.stdout, [`Web server listening on port ${PORT}\n`]);
    });
}

/**
 * Validates critical configuration values after loading from database
 */

if (require.main === module) {
    main().catch((error) => {
        originalStderrWrite.apply(process.stderr, [`Fatal error in main execution: ${error.message}\n`]);
        process.exit(1);
    });
}


