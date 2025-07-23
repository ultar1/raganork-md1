const path = require('path');
const fs = require('fs');
if (fs.existsSync('./config.env')) {
    require('dotenv').config({ path: './config.env' });
}

const { suppressLibsignalLogs, addYtdlp60fpsSupport } = require('./core/helpers');

suppressLibsignalLogs();
addYtdlp60fpsSupport();

const { initializeDatabase } = require('./core/database');
const { BotManager } = require('./core/manager');
const config = require('./config');
const { SESSION, logger } = config; // Keep logger import for potential future use or if it's used elsewhere
const http = require('http');
const axios = require('axios'); // Added axios for Telegram API calls

// === CONFIGURATION ===
const APP_NAME = process.env.APP_NAME || 'Raganork Bot'; // Changed default app name
const SESSION_ID = process.env.SESSION_ID || 'unknown-session'; // Keep for consistency if needed, though Raganork has multiple sessions
const RESTART_DELAY_MINUTES = parseInt(process.env.RESTART_DELAY_MINUTES || '1', 10); // *** SET TO 1 MIN FOR QUICK TESTING ***
const HEROKU_API_KEY = process.env.HEROKU_API_KEY; // Needed for persisting last logout alert

// === TELEGRAM SETUP ===
// It's highly recommended to set these in Heroku Config Vars
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '7350697926:AAE3TO87lDFK_hZAiOzcWnyf4XIsIeSZhLo'; // Fallback hardcoded
const TELEGRAM_USER_ID = process.env.TELEGRAM_USER_ID || '7302005705'; // Fallback hardcoded
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID || '-1002892034574'; // Fallback hardcoded

let lastLogoutMessageId = null;
let lastLogoutAlertTime = null;

// === Load LAST_LOGOUT_ALERT from Heroku config vars ===
// (Only if HEROKU_API_KEY is set)
async function loadLastLogoutAlertTime() {
    if (!HEROKU_API_KEY || !APP_NAME) {
        // Use console.log directly here as our logger override might not be fully set up yet
        console.warn('HEROKU_API_KEY or APP_NAME is not set. Cannot load LAST_LOGOUT_ALERT from Heroku config vars.');
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
                console.log(`Loaded LAST_LOGOUT_ALERT: ${parsed.toISOString()}`);
            }
        }
    } catch (err) {
        console.error(`Failed to load LAST_LOGOUT_ALERT from Heroku: ${err.message}`);
    }
}

// === Telegram helper ===
async function sendTelegramAlert(text, chatId = TELEGRAM_USER_ID) {
    if (!TELEGRAM_BOT_TOKEN) {
        console.error('TELEGRAM_BOT_TOKEN is not set. Cannot send Telegram alerts.');
        return null;
    }

    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const payload = { chat_id: chatId, text };

    try {
        const res = await axios.post(url, payload);
        console.log(`Telegram message sent to chat ID ${chatId}: ${text.substring(0, 50)}...`); // Log success
        return res.data.result.message_id;
    } catch (err) {
        console.error(`Telegram alert failed for chat ID ${chatId}: ${err.message}`);
        if (err.response) {
            console.error(`   Telegram API Response: Status ${err.response.status}, Data: ${JSON.stringify(err.response.data)}`);
        }
        return null;
    }
}

// === "Logged out" alert with 24-hr cooldown & auto-delete ===
async function sendInvalidSessionAlert(specificSessionId = null) {
    const now = new Date();
    if (lastLogoutAlertTime && (now - lastLogoutAlertTime) < 24 * 3600e3) {
        console.log('Skipping logout alert — cooldown not expired.');
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

    let message =
        `Hey 𝖀𝖑𝖙-𝕬𝕽, ${greeting}!\n\n` +
        `User [${APP_NAME}] has logged out.`;

    if (specificSessionId) {
        message += `\n[${specificSessionId}] invalid`;
    } else {
        message += `\n[${SESSION_ID}] invalid`; // Fallback to APP's SESSION_ID if not specific
    }

    message += `\nTime: ${nowStr}\n` +
        `Restarting in ${restartTimeDisplay}.`;

    try {
        // delete last one (only for the user, not channel if it's a broadcast)
        if (lastLogoutMessageId) {
            try {
                console.log(`Attempting to delete previous logout alert id ${lastLogoutMessageId}`);
                await axios.post(
                    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteMessage`,
                    { chat_id: TELEGRAM_USER_ID, message_id: lastLogoutMessageId }
                );
                console.log(`Deleted logout alert id ${lastLogoutMessageId}`);
            } catch (delErr) {
                console.warn(`Failed to delete previous message ${lastLogoutMessageId}: ${delErr.message}`);
            }
        }

        // send new one to user
        const msgId = await sendTelegramAlert(message, TELEGRAM_USER_ID);
        if (!msgId) return;

        lastLogoutMessageId = msgId;
        lastLogoutAlertTime = now;

        // Send to channel
        await sendTelegramAlert(message, TELEGRAM_CHANNEL_ID);
        console.log(`Sent new logout alert to channel ${TELEGRAM_CHANNEL_ID}`);


        // persist timestamp (only if HEROKU_API_KEY and APP_NAME are set)
        if (!HEROKU_API_KEY || !APP_NAME) {
            console.warn('HEROKU_API_KEY or APP_NAME is not set. Cannot persist LAST_LOGOUT_ALERT timestamp.');
            return;
        }
        const cfgUrl = `https://api.heroku.com/apps/${APP_NAME}/config-vars`;
        const headers = {
            Authorization: `Bearer ${HEROKU_API_KEY}`,
            Accept: 'application/vnd.heroku+json; version=3',
            'Content-Type': 'application/json'
        };
        await axios.patch(cfgUrl, { LAST_LOGOUT_ALERT: now.toISOString() }, { headers });
        console.log(`Persisted LAST_LOGOUT_ALERT timestamp.`);
    } catch (err) {
        console.error(`Failed during sendInvalidSessionAlert(): ${err.message}`);
    }
}

// Function to handle bot connected messages
async function sendBotConnectedAlert() {
    const now = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos' });
    const message = `[${APP_NAME}] connected.\n🔐 ${SESSION.join(', ')}\n🕒 ${now}`;
    await sendTelegramAlert(message, TELEGRAM_USER_ID);
    await sendTelegramAlert(message, TELEGRAM_CHANNEL_ID);
    console.log(`Sent "connected" message to channel ${TELEGRAM_CHANNEL_ID}`);
}


async function main() {
    // === CRITICAL: Override console.log and console.error at the very beginning ===
    // This will ensure we catch all messages printed to the console,
    // regardless of whether they come from `logger` or direct `console.log`.
    const originalConsoleLog = console.log;
    const originalConsoleError = console.error;

    // --- Intercept console.log ---
    console.log = function (...args) {
        const message = args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ');
        originalConsoleLog.apply(console, args); // Always call the original console.log

        // Check for 'Bot initialization complete' or any message that indicates bot started successfully
        // Your log shows "Bot initialization complete"
        if (message.includes('Bot initialization complete') || message.includes('Bot started')) {
            originalConsoleLog('[DEBUG] "Bot started" or "initialization complete" message detected via console.log!'); // <-- DEBUG LINE
            sendBotConnectedAlert();
        }
    };

    // --- Intercept console.error ---
    console.error = function (...args) {
        const message = args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ');
        originalConsoleError.apply(console, args); // Always call the original console.error

        // Refined logout patterns to be more robust
        const logoutPatterns = [
            'ERROR: Failed to initialize bot. Details: No valid session found',
            'SESSION LOGGED OUT. Please rescan QR and update SESSION.',
            'Reason: logout', // Common in some bot frameworks for logout
            'Authentication Error' // Generic auth error that might lead to logout
        ];

        if (logoutPatterns.some(pattern => message.includes(pattern))) {
            originalConsoleError('[DEBUG] Logout pattern detected in error log via console.error!'); // <-- DEBUG LINE
            // Attempt to extract session ID more generally (captures any word after "for ")
            const match = message.match(/for (\S+)\./); // Catches "for XYZ."
            const specificSessionId = match ? match[1] : null;

            sendInvalidSessionAlert(specificSessionId);
            originalConsoleError(`Detected logout for session ${specificSessionId || 'unknown'}. Exiting to trigger restart.`);
            // Only exit if HEROKU_API_KEY is configured, otherwise keep running for local debugging
            if (HEROKU_API_KEY) {
                setTimeout(() => process.exit(1), RESTART_DELAY_MINUTES * 60 * 1000);
            } else {
                originalConsoleWarn('HEROKU_API_KEY not set. Not forcing process exit after logout detection.');
            }
        }
    };

    // Also override logger.fatal in case Raganork uses it AND it eventually
    // flows to console.error or is caught by our console.error override.
    // If not, our console.error override will still catch anything written to stderr.
    const originalLoggerFatal = logger.fatal;
    logger.fatal = function(...args) {
        const message = args[0] && typeof args[0] === 'string' ? args[0] : '';
        originalLoggerFatal.apply(logger, args); // Call original logger fatal
        // Our console.error override should catch this if it's printed to console.error
        // But we add a check here too just in case.
        const logoutPatterns = [
            'ERROR: Failed to initialize bot. Details: No valid session found',
            'SESSION LOGGED OUT. Please rescan QR and update SESSION.',
            'Reason: logout',
            'Authentication Error'
        ];
        if (logoutPatterns.some(pattern => message.includes(pattern))) {
            originalConsoleError('[DEBUG] Logout pattern detected in logger.fatal!');
            const match = message.match(/for (\S+)\./);
            const specificSessionId = match ? match[1] : null;
            sendInvalidSessionAlert(specificSessionId);
            if (HEROKU_API_KEY) {
                setTimeout(() => process.exit(1), RESTART_DELAY_MINUTES * 60 * 1000);
            }
        }
    }


    // === Initialize Telegram features ===
    await loadLastLogoutAlertTime();

    if (!fs.existsSync('./temp')) {
        fs.mkdirSync('./temp', { recursive: true });
        console.log('Created temporary directory at ./temp');
        // The console.log override above will catch this, no need for logger.info here directly
    }
    console.log(`Raganork v${require('./package.json').version}`);
    console.log(`- Configured sessions: ${SESSION.join(', ')}`);
    if (SESSION.length === 0) {
        const warnMsg = '⚠️ No sessions configured. Please set SESSION environment variable.';
        console.warn(warnMsg);
        return;
    }

    try {
        await initializeDatabase();
        console.log('- Database initialized');
    } catch (dbError) {
        console.error('🚫 Failed to initialize database or load configuration. Bot cannot start.', dbError);
        process.exit(1);
    }

    const botManager = new BotManager();

    const shutdownHandler = async (signal) => {
        console.log(`\nReceived ${signal}, shutting down...`);
        await botManager.shutdown();
        process.exit(0);
    };

    process.on('SIGINT', () => shutdownHandler('SIGINT'));
    process.on('SIGTERM', () => shutdownHandler('SIGTERM'));

    await botManager.initializeBots();
    console.log('- Bot initialization complete.');
    // This `console.log` will now trigger the 'Bot connected' alert because of the override
    // No explicit `logger.info` call for "Bot initialization complete" needed here,
    // as the above `console.log` will be intercepted.


    // --- TEMPORARY TEST CALL FOR TELEGRAM ALERTS (UNCOMMENT TO TEST) ---
    // console.log('--- Initiating direct Telegram test messages ---');
    // await sendTelegramAlert('🧪 Test Message: Raganork bot is attempting to send a direct message to your user ID. If you see this, personal Telegram alerts are working!');
    // await sendTelegramAlert('📣 Test Message: Raganork bot is attempting to send a direct message to your channel. If you see this, channel alerts are working!', TELEGRAM_CHANNEL_ID);
    // console.log('--- Direct Telegram test messages sent (check Telegram) ---');
    // -------------------------------------------------------------------


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
        console.log(`Web server listening on port ${PORT}`);
    });
}

/**
 * Validates critical configuration values after loading from database
 */

if (require.main === module) {
    main().catch((error) => {
        console.error(`Fatal error in main execution: ${error.message}`, error);
        // If the main function itself has a fatal error, the console.error override will catch it.
        process.exit(1);
    });
}
