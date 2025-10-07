const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');

const {
    checkRateLimit,
    checkPurchaseCooldown,
    trackSuspiciousActivity,
    checkDuplicatePurchase,
    validateUser,
    verifyLicenseIntegrity,
    getSystemStats
} = require('./security');

const config = {
    DISCORD_TOKEN: process.env.DISCORD_TOKEN,
    CLIENT_ID: process.env.CLIENT_ID,
    FUNGIES_API_KEY: process.env.FUNGIES_API_KEY,
    FUNGIES_WEBHOOK_SECRET: process.env.FUNGIES_WEBHOOK_SECRET,
    PRODUCT_ID_2WEEKS: process.env.PRODUCT_ID_2WEEKS,
    PRODUCT_ID_MONTHLY: process.env.PRODUCT_ID_MONTHLY,
    PRODUCT_ID_LIFETIME: process.env.PRODUCT_ID_LIFETIME,
    PORT: process.env.PORT || 3000,
    WEBHOOK_URL: process.env.WEBHOOK_URL,
    LICENSE_KEY_SECRET: process.env.LICENSE_KEY_SECRET,
    ADMIN_USER_ID: process.env.ADMIN_USER_ID
};

function validateEnvironmentVariables() {
    const requiredVars = [
        'DISCORD_TOKEN',
        'CLIENT_ID', 
        'FUNGIES_API_KEY',
        'FUNGIES_WEBHOOK_SECRET',
        'PRODUCT_ID_2WEEKS',
        'PRODUCT_ID_MONTHLY',
        'PRODUCT_ID_LIFETIME',
        'WEBHOOK_URL',
        'LICENSE_KEY_SECRET',
        'ADMIN_USER_ID'
    ];
    
    const missingVars = requiredVars.filter(varName => !config[varName]);
    
    if (missingVars.length > 0) {
        console.error('❌ Missing required environment variables:');
        missingVars.forEach(varName => {
            console.error(`   - ${varName}`);
        });
        console.error('\n🔧 Please set these environment variables in Railway or your .env file');
        console.error('📖 See SETUP.md for detailed configuration instructions');
        process.exit(1);
    }
    
    console.log('✅ All required environment variables are set');
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent
    ]
});

const app = express();
app.use(express.json());
app.use(express.raw({ type: 'application/json' }));

const DATA_DIR = './data';
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const LICENSES_FILE = path.join(DATA_DIR, 'licenses.json');
const PAYMENTS_FILE = path.join(DATA_DIR, 'payments.json');

async function initializeDataFiles() {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        
        const files = [USERS_FILE, LICENSES_FILE, PAYMENTS_FILE];
        for (const file of files) {
            try {
                await fs.access(file);
            } catch {
                await fs.writeFile(file, JSON.stringify([], null, 2));
            }
        }
    } catch (error) {
        console.error('Error initializing data files:', error);
    }
}

async function readJSONFile(filePath) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error(`Error reading ${filePath}:`, error);
        return [];
    }
}

async function writeJSONFile(filePath, data) {
    try {
        await fs.writeFile(filePath, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error(`Error writing ${filePath}:`, error);
    }
}

function generateLicenseKey(userId, productType) {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 15);
    const data = `${userId}-${productType}-${timestamp}-${random}`;
    const hash = crypto.createHmac('sha256', config.LICENSE_KEY_SECRET).update(data).digest('hex').substring(0, 16);
    return `${productType.toUpperCase()}-${hash.toUpperCase()}`;
}

function calculateExpirationDate(productType) {
    const now = new Date();
    switch (productType) {
        case '2weeks':
            return new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
        case 'monthly':
            return new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
        case 'lifetime':
            return new Date(now.getTime() + 100 * 365 * 24 * 60 * 60 * 1000);
        default:
            return new Date(now.getTime() + 24 * 60 * 60 * 1000);
    }
}

// Crypto payment functions
async function getCryptoPrice(cryptoSymbol) {
    try {
        const crypto = CRYPTO_CONFIG[cryptoSymbol];
        if (!crypto) throw new Error(`Unsupported crypto: ${cryptoSymbol}`);
        
        const response = await fetch(crypto.apiUrl);
        const data = await response.json();
        
        // Navigate to the price using the field path
        const priceFields = crypto.priceField.split('.');
        let price = data;
        for (const field of priceFields) {
            price = price[field];
        }
        
        return parseFloat(price);
    } catch (error) {
        console.error(`Error fetching ${cryptoSymbol} price:`, error);
        throw new Error(`Failed to get ${cryptoSymbol} exchange rate`);
    }
}

async function calculateCryptoAmount(usdAmount, cryptoSymbol) {
    const cryptoPrice = await getCryptoPrice(cryptoSymbol);
    const amount = usdAmount / cryptoPrice;
    return parseFloat(amount.toFixed(8)); // 8 decimal places for crypto precision
}

function generateCryptoPaymentId() {
    return `crypto_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

// Blockchain monitoring functions
async function checkBTCTransaction(address, expectedAmount, since) {
    try {
        const response = await fetch(`https://blockstream.info/api/address/${address}/txs`);
        const transactions = await response.json();
        
        for (const tx of transactions) {
            // Check if transaction is after payment creation time
            if (tx.status.block_time && tx.status.block_time * 1000 < since) continue;
            
            // Check outputs for exact amount to our address
            for (const output of tx.vout) {
                if (output.scriptpubkey_address === address) {
                    const receivedAmount = output.value / 100000000; // Convert satoshis to BTC
                    if (Math.abs(receivedAmount - expectedAmount) < 0.00001) { // Allow for tiny rounding differences
                        return {
                            found: true,
                            txid: tx.txid,
                            amount: receivedAmount,
                            confirmations: tx.status.confirmed ? 1 : 0
                        };
                    }
                }
            }
        }
        return { found: false };
    } catch (error) {
        console.error('Error checking BTC transaction:', error);
        return { found: false, error: error.message };
    }
}

async function checkLTCTransaction(address, expectedAmount, since) {
    try {
        const response = await fetch(`https://api.blockchair.com/litecoin/dashboards/address/${address}?limit=10`);
        const data = await response.json();
        
        if (data.data && data.data[address] && data.data[address].transactions) {
            for (const txHash of data.data[address].transactions) {
                // Get transaction details
                const txResponse = await fetch(`https://api.blockchair.com/litecoin/dashboards/transaction/${txHash}`);
                const txData = await txResponse.json();
                
                if (txData.data && txData.data[txHash]) {
                    const tx = txData.data[txHash].transaction;
                    
                    // Check if transaction is after payment creation time
                    if (new Date(tx.time).getTime() < since) continue;
                    
                    // Check outputs for exact amount to our address
                    const outputs = txData.data[txHash].outputs;
                    for (const output of outputs) {
                        if (output.recipient === address) {
                            const receivedAmount = output.value / 100000000; // Convert to LTC
                            if (Math.abs(receivedAmount - expectedAmount) < 0.00001) {
                                return {
                                    found: true,
                                    txid: txHash,
                                    amount: receivedAmount,
                                    confirmations: tx.block_id ? 1 : 0
                                };
                            }
                        }
                    }
                }
            }
        }
        return { found: false };
    } catch (error) {
        console.error('Error checking LTC transaction:', error);
        return { found: false, error: error.message };
    }
}

async function monitorCryptoPayment(paymentId) {
    try {
        console.log(`🔍 Starting monitoring for crypto payment: ${paymentId}`);
        
        const cryptoPayments = await readJSONFile('./data/crypto_payments.json').catch(() => []);
        const payment = cryptoPayments.find(p => p.paymentId === paymentId);
        
        if (!payment) {
            console.log(`Payment ${paymentId} not found`);
            return;
        }
        
        const crypto = CRYPTO_CONFIG[payment.cryptoSymbol];
        if (!crypto) {
            console.log(`Crypto config not found for ${payment.cryptoSymbol}`);
            return;
        }
        
        const checkInterval = 30000; // Check every 30 seconds
        const maxChecks = 60; // Check for 30 minutes (60 * 30 seconds)
        let checks = 0;
        
        const monitor = setInterval(async () => {
            checks++;
            
            try {
                // Check if payment has expired
                if (Date.now() > payment.expiresAt) {
                    console.log(`Payment ${paymentId} has expired`);
                    clearInterval(monitor);
                    await updatePaymentStatus(paymentId, 'expired');
                    return;
                }
                
                // Check blockchain for transaction
                let result;
                if (payment.cryptoSymbol === 'btc') {
                    result = await checkBTCTransaction(crypto.address, payment.cryptoAmount, payment.createdAt);
                } else if (payment.cryptoSymbol === 'ltc') {
                    result = await checkLTCTransaction(crypto.address, payment.cryptoAmount, payment.createdAt);
                }
                
                if (result && result.found) {
                    console.log(`✅ Payment confirmed for ${paymentId}! Transaction: ${result.txid}`);
                    clearInterval(monitor);
                    
                    // Update payment status
                    await updatePaymentStatus(paymentId, 'completed', result.txid);
                    
                    // Generate and deliver license key
                    await deliverCryptoLicense(payment, result);
                    return;
                }
                
                // Stop monitoring after maximum checks
                if (checks >= maxChecks) {
                    console.log(`Payment ${paymentId} monitoring timeout`);
                    clearInterval(monitor);
                    await updatePaymentStatus(paymentId, 'expired');
                }
                
            } catch (error) {
                console.error(`Error monitoring payment ${paymentId}:`, error);
            }
        }, checkInterval);
        
    } catch (error) {
        console.error('Error starting payment monitoring:', error);
    }
}

async function updatePaymentStatus(paymentId, status, txid = null) {
    try {
        const cryptoPayments = await readJSONFile('./data/crypto_payments.json').catch(() => []);
        const paymentIndex = cryptoPayments.findIndex(p => p.paymentId === paymentId);
        
        if (paymentIndex !== -1) {
            cryptoPayments[paymentIndex].status = status;
            if (txid) cryptoPayments[paymentIndex].txid = txid;
            cryptoPayments[paymentIndex].updatedAt = Date.now();
            
            await writeJSONFile('./data/crypto_payments.json', cryptoPayments);
        }
    } catch (error) {
        console.error('Error updating payment status:', error);
    }
}

async function deliverCryptoLicense(payment, transactionResult) {
    try {
        const user = await client.users.fetch(payment.userId);
        const licenseKey = generateLicenseKey(payment.userId, payment.productType);
        
        // Save license to file
        const licenses = await readJSONFile('./data/licenses.json').catch(() => []);
        const newLicense = {
            key: licenseKey,
            userId: payment.userId,
            type: payment.productType,
            createdAt: Date.now(),
            expiresAt: Date.now() + (payment.productType === '2weeks' ? 14 : payment.productType === 'monthly' ? 30 : 365 * 10) * 24 * 60 * 60 * 1000,
            paymentMethod: 'crypto',
            paymentId: payment.paymentId,
            txid: transactionResult.txid
        };
        
        licenses.push(newLicense);
        await writeJSONFile('./data/licenses.json', licenses);
        
        // Create redemption link
        const redemptionLink = `https://your-redemption-site.com/redeem?key=${licenseKey}`;
        
        // Send license to user
        const embed = new EmbedBuilder()
            .setColor('#00ff00')
            .setTitle('🎉 Payment Confirmed!')
            .setDescription(`Your cryptocurrency payment has been confirmed!`)
            .addFields(
                { name: '📦 Product', value: PRODUCTS[payment.productType].name, inline: true },
                { name: '💰 Amount', value: `${payment.cryptoAmount} ${payment.cryptoSymbol.toUpperCase()}`, inline: true },
                { name: '🔗 Transaction', value: `[View on Blockchain](${payment.cryptoSymbol === 'btc' ? 'https://blockstream.info/tx/' : 'https://blockchair.com/litecoin/transaction/'}${transactionResult.txid})`, inline: true },
                { name: '🔑 License Key', value: `\`${licenseKey}\``, inline: false },
                { name: '🌐 Redemption Link', value: `[Click here to redeem](${redemptionLink})`, inline: false }
            )
            .setFooter({ text: 'Thank you for your purchase!' })
            .setTimestamp();
        
        await user.send({ embeds: [embed] });
        
        console.log(`✅ License delivered to user ${payment.userId} for crypto payment ${payment.paymentId}`);
        
    } catch (error) {
        console.error('Error delivering crypto license:', error);
    }
}

// Payment cleanup and notification functions
async function cleanupExpiredPayments() {
    try {
        const cryptoPayments = await readJSONFile('./data/crypto_payments.json').catch(() => []);
        const now = Date.now();
        let hasChanges = false;
        
        for (let i = 0; i < cryptoPayments.length; i++) {
            const payment = cryptoPayments[i];
            
            // Check if payment is expired and still pending
            if (payment.status === 'pending' && now > payment.expiresAt) {
                console.log(`Cleaning up expired payment: ${payment.paymentId}`);
                
                // Update payment status
                cryptoPayments[i].status = 'expired';
                cryptoPayments[i].updatedAt = now;
                hasChanges = true;
                
                // Notify user about expiration
                try {
                    const user = await client.users.fetch(payment.userId);
                    const product = PRODUCTS[payment.productType];
                    
                    const embed = new EmbedBuilder()
                        .setColor('#ff6b6b')
                        .setTitle('⏰ Payment Expired')
                        .setDescription(`Your cryptocurrency payment window has expired.`)
                        .addFields(
                            { name: '📦 Product', value: product.name, inline: true },
                            { name: '💰 Amount', value: `${payment.cryptoAmount} ${payment.cryptoSymbol.toUpperCase()}`, inline: true },
                            { name: '🔄 Next Steps', value: 'Use `/buy` to start a new payment', inline: false }
                        )
                        .setFooter({ text: 'Payment windows are valid for 30 minutes' })
                        .setTimestamp();
                    
                    await user.send({ embeds: [embed] });
                } catch (notifyError) {
                    console.error(`Failed to notify user ${payment.userId} about expired payment:`, notifyError);
                }
            }
        }
        
        // Save changes if any
        if (hasChanges) {
            await writeJSONFile('./data/crypto_payments.json', cryptoPayments);
        }
        
    } catch (error) {
        console.error('Error cleaning up expired payments:', error);
    }
}

// Start periodic cleanup when bot is ready
function startPaymentCleanup() {
    // Run cleanup every 5 minutes
    setInterval(cleanupExpiredPayments, 5 * 60 * 1000);
    console.log('🧹 Payment cleanup service started');
}

const PRODUCTS = {
    '2weeks': {
        name: '2 Weeks Access',
        price: '$6.99 + taxes',
        description: 'Full access for 2 weeks',
        productId: config.PRODUCT_ID_2WEEKS,
        duration: '14 days',
        cryptoPrice: 5.00
    },
    'monthly': {
        name: 'Monthly Access',
        price: '$11 + taxes',
        description: 'Full access for 1 month',
        productId: config.PRODUCT_ID_MONTHLY,
        duration: '30 days',
        cryptoPrice: 9.00
    },
    'lifetime': {
        name: 'Lifetime Access',
        price: '$22 + taxes',
        description: 'Unlimited access forever',
        productId: config.PRODUCT_ID_LIFETIME,
        duration: 'Forever',
        cryptoPrice: 21.00
    }
};

// Crypto payment configuration
const CRYPTO_CONFIG = {
    BTC: {
        name: 'Bitcoin',
        symbol: 'BTC',
        address: 'bc1q8tdnwuhw2vqcyp5dfpzwjzgf2t3rsdamug9zf9',
        apiUrl: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
        priceField: 'bitcoin.usd'
    },
    LTC: {
        name: 'Litecoin',
        symbol: 'LTC',
        address: 'LRQ4nSdQaEccRfPNbaKtJ7SU3Ka3P8Eo9D',
        apiUrl: 'https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=usd',
        priceField: 'litecoin.usd'
    }
};

client.once('ready', async () => {
    console.log(`✅ Bot is ready! Logged in as ${client.user.tag}`);
    
    const commands = [
        new SlashCommandBuilder()
            .setName('buy')
            .setDescription('Purchase a subscription to access premium features'),
        
        new SlashCommandBuilder()
            .setName('license')
            .setDescription('Check your current license status'),
            
        new SlashCommandBuilder()
            .setName('payment')
            .setDescription('Check your pending crypto payment status'),
            
        new SlashCommandBuilder()
            .setName('help')
            .setDescription('Get help with bot commands'),
            
        new SlashCommandBuilder()
            .setName('myid')
            .setDescription('Get your Discord user ID (for admin setup)'),
            
        new SlashCommandBuilder()
            .setName('add')
            .setDescription('Add license keys manually (Admin only)')
            .addSubcommand(subcommand =>
                subcommand
                    .setName('keys')
                    .setDescription('Add multiple license keys'))
    ];

    try {
        console.log('🔄 Started refreshing application (/) commands.');
        
        await client.application.commands.set(commands);
        
        console.log('✅ Successfully reloaded application (/) commands.');
        
        // Start payment cleanup service
        startPaymentCleanup();
    } catch (error) {
        console.error('❌ Error registering commands:', error);
    }
});

client.on('interactionCreate', async interaction => {
    if (interaction.isChatInputCommand()) {
        const { commandName, user } = interaction;

        try {
            if (commandName === 'buy') {
                await handleBuyCommand(interaction);
            } else if (commandName === 'license') {
                await handleLicenseCommand(interaction);
            } else if (commandName === 'payment') {
                await handlePaymentStatusCommand(interaction);
            } else if (commandName === 'help') {
                await handleHelpCommand(interaction);
            } else if (commandName === 'myid') {
                await handleMyIdCommand(interaction);
            } else if (commandName === 'add') {
                await handleAddCommand(interaction);
            }
        } catch (error) {
            console.error('Error handling command:', error);
            await interaction.reply({ 
                content: 'An error occurred while processing your command. Please try again later.', 
                ephemeral: true 
            });
        }
    } else if (interaction.isModalSubmit()) {
        if (interaction.customId === 'addKeysModal') {
            await handleAddKeysModal(interaction);
        }
    }
});

async function handleBuyCommand(interaction) {
    if (interaction.guild) {
        await interaction.reply({
            content: '🔒 Please send me a direct message to purchase a subscription for privacy and security.',
            ephemeral: true
        });
        return;
    }

    const userId = interaction.user.id;

    if (!checkRateLimit(userId, 'buy', 3, 60000)) {
        await interaction.reply({
            content: '⏰ You\'re doing that too fast! Please wait a moment before trying again.',
            ephemeral: true
        });
        return;
    }

    const userValidation = validateUser(interaction.user);
    if (!userValidation.isValid) {
        if (userValidation.requiresManualReview) {
            await interaction.reply({
                content: '⚠️ Your account requires manual review. Please contact an administrator.',
                ephemeral: true
            });
            console.log(`⚠️ User ${userId} flagged for manual review: ${userValidation.reason}`);
            return;
        }
    }

    trackSuspiciousActivity(userId, 'buy_command');

    const embed = new EmbedBuilder()
        .setTitle('🛒 Premium Subscription Options')
        .setDescription('Choose your subscription plan and payment method:')
        .setColor(0x00AE86)
        .addFields(
            {
                name: '📅 2 Weeks Access',
                value: `**Fungies:** ${PRODUCTS['2weeks'].price}\n**Crypto:** $${PRODUCTS['2weeks'].cryptoPrice}\n${PRODUCTS['2weeks'].description}`,
                inline: true
            },
            {
                name: '📅 Monthly Access',
                value: `**Fungies:** ${PRODUCTS['monthly'].price}\n**Crypto:** $${PRODUCTS['monthly'].cryptoPrice}\n${PRODUCTS['monthly'].description}`,
                inline: true
            },
            {
                name: '♾️ Lifetime Access',
                value: `**Fungies:** ${PRODUCTS['lifetime'].price}\n**Crypto:** $${PRODUCTS['lifetime'].cryptoPrice}\n${PRODUCTS['lifetime'].description}`,
                inline: true
            }
        )
        .setFooter({ text: 'Select a plan below to choose your payment method' })
        .setTimestamp();

    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('select_2weeks')
                .setLabel('Select 2 Weeks')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('📅'),
            new ButtonBuilder()
                .setCustomId('select_monthly')
                .setLabel('Select Monthly')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('📅'),
            new ButtonBuilder()
                .setCustomId('select_lifetime')
                .setLabel('Select Lifetime')
                .setStyle(ButtonStyle.Success)
                .setEmoji('♾️')
        );

    await interaction.reply({ embeds: [embed], components: [row] });
}

async function handleLicenseCommand(interaction) {
    const userId = interaction.user.id;
    const licenses = await readJSONFile(LICENSES_FILE);
    const userLicenses = licenses.filter(license => license.userId === userId && license.isActive);

    if (userLicenses.length === 0) {
        await interaction.reply({
            content: '❌ You don\'t have any active licenses. Use `/buy` to purchase a subscription.',
            ephemeral: true
        });
        return;
    }

    const embed = new EmbedBuilder()
        .setTitle('📋 Your Active Licenses')
        .setColor(0x00AE86)
        .setTimestamp();

    userLicenses.forEach(license => {
        const product = PRODUCTS[license.productType];
        const expirationDate = new Date(license.expirationDate);
        const isExpired = expirationDate < new Date();
        
        embed.addFields({
            name: `${product.name}`,
            value: `**License Key:** \`${license.licenseKey}\`\n**Status:** ${isExpired ? '❌ Expired' : '✅ Active'}\n**Expires:** ${expirationDate.toLocaleDateString()}`,
            inline: false
        });
    });

    await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handlePaymentStatusCommand(interaction) {
    try {
        const cryptoPayments = await readJSONFile('./data/crypto_payments.json').catch(() => []);
        const userPayments = cryptoPayments.filter(p => p.userId === interaction.user.id && p.status === 'pending');
        
        if (userPayments.length === 0) {
            const embed = new EmbedBuilder()
                .setTitle('💳 Payment Status')
                .setDescription('You have no pending cryptocurrency payments.')
                .setColor('#ffa500')
                .addFields({
                    name: '💡 Need to make a payment?',
                    value: 'Use `/buy` to start a new purchase.',
                    inline: false
                });
            
            await interaction.reply({ embeds: [embed], ephemeral: true });
            return;
        }
        
        const embed = new EmbedBuilder()
            .setTitle('💳 Pending Crypto Payments')
            .setDescription('Here are your pending cryptocurrency payments:')
            .setColor('#f39c12');
        
        userPayments.forEach(payment => {
            const product = PRODUCTS[payment.productType];
            const crypto = CRYPTO_CONFIG[payment.cryptoSymbol];
            const timeLeft = Math.max(0, payment.expiresAt - Date.now());
            const minutesLeft = Math.floor(timeLeft / (1000 * 60));
            
            embed.addFields({
                name: `${product.name} - ${payment.cryptoSymbol.toUpperCase()}`,
                value: `**Amount:** ${payment.cryptoAmount} ${payment.cryptoSymbol.toUpperCase()}\n**Address:** \`${crypto.address}\`\n**Time Left:** ${minutesLeft > 0 ? `${minutesLeft} minutes` : 'Expired'}\n**Status:** ${timeLeft > 0 ? '⏳ Awaiting Payment' : '❌ Expired'}`,
                inline: false
            });
        });
        
        if (userPayments.some(p => p.expiresAt > Date.now())) {
            embed.setFooter({ text: 'Send the exact amount to the wallet address to complete your purchase.' });
        }
        
        await interaction.reply({ embeds: [embed], ephemeral: true });
        
    } catch (error) {
        console.error('Error checking payment status:', error);
        await interaction.reply({ 
            content: '❌ Unable to check payment status. Please try again later.', 
            ephemeral: true 
        });
    }
}

async function handleHelpCommand(interaction) {
    const embed = new EmbedBuilder()
        .setTitle('📚 Bot Help')
        .setDescription('Here are the available commands:')
        .setColor(0x0099FF)
        .addFields(
            {
                name: '/buy',
                value: 'Purchase a subscription (must be used in DMs)',
                inline: false
            },
            {
                name: '/license',
                value: 'Check your current license status',
                inline: false
            },
            {
                name: '/payment',
                value: 'Check your pending crypto payment status',
                inline: false
            },
            {
                name: '/help',
                value: 'Show this help message',
                inline: false
            },
            {
                name: '/myid',
                value: 'Get your Discord user ID (for admin setup)',
                inline: false
            },
            {
                name: '/add keys',
                value: 'Add license keys manually (Admin only)',
                inline: false
            }
        )
        .setFooter({ text: 'For support, contact the server administrators' })
        .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleMyIdCommand(interaction) {
    const embed = new EmbedBuilder()
        .setTitle('🆔 Your Discord User ID')
        .setDescription(`Your Discord User ID is: \`${interaction.user.id}\``)
        .setColor(0x00AE86)
        .addFields(
            {
                name: '📋 How to use this ID',
                value: 'Copy this ID and set it as `ADMIN_USER_ID` in your Railway environment variables to gain admin access.',
                inline: false
            },
            {
                name: '⚙️ Railway Setup',
                value: '1. Go to Railway Dashboard\n2. Select your project\n3. Go to Variables tab\n4. Set `ADMIN_USER_ID` = `' + interaction.user.id + '`',
                inline: false
            }
        )
        .setFooter({ text: 'This message is only visible to you' })
        .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleAddCommand(interaction) {
    console.log(`🔧 Admin command attempted by ${interaction.user.tag} (${interaction.user.id})`);
    console.log(`🔧 Current ADMIN_USER_ID: ${config.ADMIN_USER_ID}`);
    
    if (interaction.user.id !== config.ADMIN_USER_ID) {
        await interaction.reply({
            content: '❌ You do not have permission to use this command.',
            ephemeral: true
        });
        return;
    }

    const subcommand = interaction.options.getSubcommand();
    console.log(`🔧 Subcommand: ${subcommand}`);
    
    if (subcommand === 'keys') {
        try {
            const modal = new ModalBuilder()
                .setCustomId('addKeysModal')
                .setTitle('Add License Keys');

            const keysInput = new TextInputBuilder()
                .setCustomId('licenseKeys')
                .setLabel('License Keys (one per line)')
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder('LIFETIME-ABCD1234\nMONTHLY-EFGH5678\n2WEEKS-IJKL9012')
                .setRequired(true)
                .setMaxLength(4000);

            const productTypeInput = new TextInputBuilder()
                .setCustomId('productType')
                .setLabel('Product Type')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('2weeks, monthly, or lifetime')
                .setRequired(true)
                .setMaxLength(20);

            const userIdInput = new TextInputBuilder()
                .setCustomId('userId')
                .setLabel('User ID (optional)')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('Leave blank for unassigned keys')
                .setRequired(false)
                .setMaxLength(20);

            const firstActionRow = new ActionRowBuilder().addComponents(keysInput);
            const secondActionRow = new ActionRowBuilder().addComponents(productTypeInput);
            const thirdActionRow = new ActionRowBuilder().addComponents(userIdInput);

            modal.addComponents(firstActionRow, secondActionRow, thirdActionRow);

            await interaction.showModal(modal);
            console.log(`🔧 Modal shown successfully to ${interaction.user.tag}`);
        } catch (modalError) {
            console.error('🔧 Error creating/showing modal:', modalError);
            await interaction.reply({
                content: `❌ Error creating modal: ${modalError.message}`,
                ephemeral: true
            });
        }
    }
}

async function handleAddKeysModal(interaction) {
    try {
        const licenseKeysText = interaction.fields.getTextInputValue('licenseKeys');
        const productType = interaction.fields.getTextInputValue('productType').toLowerCase().trim();
        const userIdInput = interaction.fields.getTextInputValue('userId').trim();

        if (!['2weeks', 'monthly', 'lifetime'].includes(productType)) {
            await interaction.reply({
                content: '❌ Invalid product type. Use: 2weeks, monthly, or lifetime',
                ephemeral: true
            });
            return;
        }

        const licenseKeys = licenseKeysText
            .split('\n')
            .map(key => key.trim())
            .filter(key => key.length > 0);

        if (licenseKeys.length === 0) {
            await interaction.reply({
                content: '❌ No valid license keys provided.',
                ephemeral: true
            });
            return;
        }

        let userId = null;
        if (userIdInput) {
            if (!/^\d{17,19}$/.test(userIdInput)) {
                await interaction.reply({
                    content: '❌ Invalid user ID format. User ID should be 17-19 digits.',
                    ephemeral: true
                });
                return;
            }
            userId = userIdInput;
        }

        const licenses = await readJSONFile(LICENSES_FILE);
        
        const existingKeys = licenses.map(l => l.licenseKey);
        const duplicateKeys = licenseKeys.filter(key => existingKeys.includes(key));
        
        if (duplicateKeys.length > 0) {
            await interaction.reply({
                content: `❌ The following keys already exist:\n\`${duplicateKeys.join('\n')}\``,
                ephemeral: true
            });
            return;
        }

        const expirationDate = calculateExpirationDate(productType);
        
        const addedLicenses = [];
        for (const licenseKey of licenseKeys) {
            const newLicense = {
                licenseKey: licenseKey,
                userId: userId,
                productType: productType,
                productId: PRODUCTS[productType].productId,
                paymentId: `manual-${uuidv4()}`,
                isActive: true,
                createdAt: new Date().toISOString(),
                expirationDate: expirationDate.toISOString(),
                addedBy: interaction.user.id,
                addedManually: true
            };
            
            licenses.push(newLicense);
            addedLicenses.push(newLicense);
        }

        await writeJSONFile(LICENSES_FILE, licenses);

        const embed = new EmbedBuilder()
            .setTitle('✅ License Keys Added Successfully')
            .setColor(0x00FF00)
            .addFields(
                {
                    name: '📊 Summary',
                    value: `**Added:** ${licenseKeys.length} keys\n**Product Type:** ${PRODUCTS[productType].name}\n**Assigned to:** ${userId ? `<@${userId}>` : 'Unassigned'}\n**Expires:** ${expirationDate.toLocaleDateString()}`,
                    inline: false
                },
                {
                    name: '🔑 Added Keys',
                    value: licenseKeys.length > 10 
                        ? `\`${licenseKeys.slice(0, 10).join('\n')}\`\n... and ${licenseKeys.length - 10} more`
                        : `\`${licenseKeys.join('\n')}\``,
                    inline: false
                }
            )
            .setFooter({ text: `Added by ${interaction.user.tag}` })
            .setTimestamp();

        await interaction.reply({ embeds: [embed], ephemeral: true });

        if (userId) {
            try {
                const user = await client.users.fetch(userId);
                const userEmbed = new EmbedBuilder()
                    .setTitle('🎉 New License Keys Added!')
                    .setDescription('You have been granted new license keys:')
                    .setColor(0x00FF00)
                    .addFields(
                        {
                            name: '🔑 Your New Keys',
                            value: `\`${licenseKeys.join('\n')}\``,
                            inline: false
                        },
                        {
                            name: '📦 Product',
                            value: PRODUCTS[productType].name,
                            inline: true
                        },
                        {
                            name: '⏰ Expires',
                            value: expirationDate.toLocaleDateString(),
                            inline: true
                        }
                    )
                    .setFooter({ text: 'Use /license to check all your active licenses' })
                    .setTimestamp();

                await user.send({ embeds: [userEmbed] });
                console.log(`✅ Sent license keys to user ${userId}`);
            } catch (error) {
                console.error(`❌ Could not send license keys to user ${userId}:`, error);
            }
        }

        console.log(`✅ Admin ${interaction.user.id} added ${licenseKeys.length} license keys`);
        
    } catch (error) {
        console.error('Error handling add keys modal:', error);
        await interaction.reply({
            content: '❌ An error occurred while adding license keys. Please try again.',
            ephemeral: true
        });
    }
}

client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;

    const [action, productType, paymentMethod] = interaction.customId.split('_');
    
    if (action === 'select') {
        await handleProductSelection(interaction, productType);
    } else if (action === 'buy') {
        await handlePurchase(interaction, productType);
    } else if (action === 'crypto') {
        await handleCryptoSelection(interaction, productType);
    } else if (action === 'pay') {
        await handleCryptoPayment(interaction, productType, paymentMethod);
    }
});

async function handleProductSelection(interaction, productType) {
    const product = PRODUCTS[productType];
    
    if (!product) {
        await interaction.reply({ content: 'Invalid product type.', ephemeral: true });
        return;
    }

    const embed = new EmbedBuilder()
        .setTitle(`💳 Payment Method - ${product.name}`)
        .setDescription('Choose your preferred payment method:')
        .setColor(0x00AE86)
        .addFields(
            {
                name: '💳 Fungies Payment',
                value: `**Price:** ${product.price}\n✅ Instant activation\n✅ Secure payment processing\n✅ Multiple payment options`,
                inline: true
            },
            {
                name: '₿ Cryptocurrency',
                value: `**Price:** $${product.cryptoPrice}\n✅ No fees\n✅ BTC & LTC accepted\n✅ Direct wallet payment`,
                inline: true
            }
        )
        .setFooter({ text: 'Select your preferred payment method below' })
        .setTimestamp();

    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`buy_${productType}`)
                .setLabel(`Pay with Fungies - ${product.price}`)
                .setStyle(ButtonStyle.Primary)
                .setEmoji('💳'),
            new ButtonBuilder()
                .setCustomId(`crypto_${productType}`)
                .setLabel(`Pay with Crypto - $${product.cryptoPrice}`)
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('₿')
        );

    await interaction.reply({ embeds: [embed], components: [row] });
}

async function handleCryptoSelection(interaction, productType) {
    const product = PRODUCTS[productType];
    
    if (!product) {
        await interaction.reply({ content: 'Invalid product type.', ephemeral: true });
        return;
    }

    try {
        // Get real-time crypto prices
        const btcPrice = await getCryptoPrice('BTC');
        const ltcPrice = await getCryptoPrice('LTC');
        
        const btcAmount = await calculateCryptoAmount(product.cryptoPrice, 'BTC');
        const ltcAmount = await calculateCryptoAmount(product.cryptoPrice, 'LTC');

        const embed = new EmbedBuilder()
            .setTitle(`₿ Crypto Payment - ${product.name}`)
            .setDescription(`Choose your cryptocurrency for **$${product.cryptoPrice}** payment:`)
            .setColor(0xF7931A)
            .addFields(
                {
                    name: '₿ Bitcoin (BTC)',
                    value: `**Amount:** ${btcAmount} BTC\n**Rate:** $${btcPrice.toLocaleString()} USD/BTC\n**Network:** Bitcoin`,
                    inline: true
                },
                {
                    name: '🔸 Litecoin (LTC)',
                    value: `**Amount:** ${ltcAmount} LTC\n**Rate:** $${ltcPrice.toLocaleString()} USD/LTC\n**Network:** Litecoin`,
                    inline: true
                }
            )
            .setFooter({ text: 'Rates are updated in real-time • Payment must be exact amount' })
            .setTimestamp();

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`pay_${productType}_BTC`)
                    .setLabel(`Pay ${btcAmount} BTC`)
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('₿'),
                new ButtonBuilder()
                    .setCustomId(`pay_${productType}_LTC`)
                    .setLabel(`Pay ${ltcAmount} LTC`)
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('🔸')
            );

        await interaction.reply({ embeds: [embed], components: [row] });
        
    } catch (error) {
        console.error('Error fetching crypto prices:', error);
        await interaction.reply({
            content: '❌ Unable to fetch current crypto rates. Please try again in a moment.',
            ephemeral: true
        });
    }
}

async function handleCryptoPayment(interaction, productType, cryptoSymbol) {
    const product = PRODUCTS[productType];
    const crypto = CRYPTO_CONFIG[cryptoSymbol];
    const userId = interaction.user.id;
    
    if (!product || !crypto) {
        await interaction.reply({ content: 'Invalid payment configuration.', ephemeral: true });
        return;
    }

    if (!checkPurchaseCooldown(userId, 300000)) {
        await interaction.reply({
            content: '⏰ Please wait 5 minutes between purchase attempts to prevent fraud.',
            ephemeral: true
        });
        return;
    }

    const duplicateCheck = await checkDuplicatePurchase(userId, productType);
    if (duplicateCheck.isDuplicate) {
        await interaction.reply({
            content: `❌ ${duplicateCheck.reason}. Please check your existing licenses with \`/license\`.`,
            ephemeral: true
        });
        return;
    }

    try {
        const cryptoAmount = await calculateCryptoAmount(product.cryptoPrice, cryptoSymbol);
        const paymentId = generateCryptoPaymentId();
        
        // Store pending crypto payment
        const cryptoPayments = await readJSONFile('./data/crypto_payments.json').catch(() => []);
        const cryptoPayment = {
            paymentId,
            userId,
            productType,
            cryptoSymbol,
            cryptoAmount,
            usdAmount: product.cryptoPrice,
            address: crypto.address,
            status: 'pending',
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() // 30 minutes
        };
        
        cryptoPayments.push(cryptoPayment);
        await writeJSONFile('./data/crypto_payments.json', cryptoPayments);

        const embed = new EmbedBuilder()
            .setTitle(`₿ ${crypto.name} Payment Instructions`)
            .setDescription(`Send **exactly** \`${cryptoAmount}\` ${cryptoSymbol} to complete your purchase.`)
            .setColor(0xF7931A)
            .addFields(
                {
                    name: '📦 Product',
                    value: product.name,
                    inline: true
                },
                {
                    name: '💰 Amount',
                    value: `${cryptoAmount} ${cryptoSymbol}`,
                    inline: true
                },
                {
                    name: '🏦 Wallet Address',
                    value: `\`${crypto.address}\``,
                    inline: false
                },
                {
                    name: '🔍 Payment ID',
                    value: `\`${paymentId}\``,
                    inline: true
                },
                {
                    name: '⏰ Expires',
                    value: '<t:' + Math.floor((Date.now() + 30 * 60 * 1000) / 1000) + ':R>',
                    inline: true
                },
                {
                    name: '⚠️ Important Instructions',
                    value: '• Send **EXACTLY** the specified amount\n• Use the correct network\n• Payment is auto-detected\n• License key will be sent when confirmed',
                    inline: false
                }
            )
            .setFooter({ text: 'We will automatically detect your payment and send your license key' })
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
        
        // Start monitoring for this payment
        monitorCryptoPayment(paymentId);
        
    } catch (error) {
        console.error('Error creating crypto payment:', error);
        await interaction.reply({
            content: '❌ Unable to create crypto payment. Please try again.',
            ephemeral: true
        });
    }
}

async function handlePurchase(interaction, productType) {
    const product = PRODUCTS[productType];
    const userId = interaction.user.id;
    
    if (!product) {
        await interaction.reply({ content: 'Invalid product type.', ephemeral: true });
        return;
    }

    if (!checkPurchaseCooldown(userId, 300000)) {
        await interaction.reply({
            content: '⏰ Please wait 5 minutes between purchase attempts to prevent fraud.',
            ephemeral: true
        });
        return;
    }

    const duplicateCheck = await checkDuplicatePurchase(userId, productType);
    if (duplicateCheck.isDuplicate) {
        await interaction.reply({
            content: `❌ ${duplicateCheck.reason}. Please check your existing licenses with \`/license\`.`,
            ephemeral: true
        });
        return;
    }

    trackSuspiciousActivity(userId, `purchase_attempt_${productType}`);

    const paymentData = {
        userId: interaction.user.id,
        productType: productType,
        productId: product.productId,
        timestamp: Date.now()
    };

    const payments = await readJSONFile(PAYMENTS_FILE);
    const paymentId = uuidv4();
    payments.push({
        paymentId,
        ...paymentData,
        status: 'pending',
        createdAt: new Date().toISOString()
    });
    await writeJSONFile(PAYMENTS_FILE, payments);

    // Prepare custom data for Fungies.io
    const customData = encodeURIComponent(JSON.stringify({
        userId: interaction.user.id, 
        paymentId: paymentId
    }));
    
    const paymentUrl = `https://roxgames.app.fungies.io/checkout/${product.productId}?custom_data=${customData}`;
    
    console.log(`💳 Generated payment URL for ${interaction.user.tag}: ${paymentUrl}`);

    const embed = new EmbedBuilder()
        .setTitle('💳 Complete Your Purchase')
        .setDescription(`You've selected: **${product.name}**\nPrice: **${product.price}**`)
        .setColor(0x00AE86)
        .addFields(
            {
                name: '🔗 Payment Link',
                value: `[Click here to complete payment](${paymentUrl})`,
                inline: false
            },
            {
                name: '⚠️ Important',
                value: 'After payment, you\'ll receive your license key automatically.\n\n**Security Notice:** This link is unique to you and expires in 30 minutes.',
                inline: false
            }
        )
        .setFooter({ text: 'Payment powered by Fungies.io • Secure & Encrypted' })
        .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
}

console.log('🚀 Starting Discord bot...');

validateEnvironmentVariables();

initializeDataFiles().then(() => {
    client.login(config.DISCORD_TOKEN);
});

// Test endpoint to verify webhook connectivity
app.get('/webhook', (req, res) => {
    res.json({ 
        status: 'Webhook endpoint is reachable', 
        timestamp: new Date().toISOString(),
        bot: 'Priv9 Payments'
    });
});

app.post('/webhook', async (req, res) => {
    try {
        console.log('📦 Webhook received at:', new Date().toISOString());
        console.log('📦 Headers:', req.headers);
        console.log('📦 Body:', req.body);
        
        const signature = req.headers['x-fngs-signature'];
        console.log('📦 Signature:', signature);
        
        if (!verifyWebhookSignature(req.body, signature)) {
            console.log('❌ Invalid webhook signature');
            return res.status(401).send('Unauthorized');
        }
        
        console.log('✅ Webhook signature verified');

        const { type, data } = req.body;
        console.log('📦 Event type:', type);
        console.log('📦 Event data:', data);

        if (type === 'payment_success') {
            console.log('💰 Processing payment_success event');
            await handlePaymentCompleted(data);
        } else {
            console.log('❓ Unknown event type:', type);
        }

        res.status(200).send('OK');
    } catch (error) {
        console.error('❌ Webhook error:', error);
        res.status(500).send('Internal Server Error');
    }
});

function verifyWebhookSignature(payload, signature) {
    const expectedSignature = crypto
        .createHmac('sha256', config.FUNGIES_WEBHOOK_SECRET)
        .update(JSON.stringify(payload))
        .digest('hex');
    
    // Fungies.io sends signature in format "sha256_<hash>"
    const receivedSignature = signature?.startsWith('sha256_') ? signature.slice(7) : signature;
    
    console.log('🔍 Signature verification:');
    console.log('  - Received:', signature);
    console.log('  - Extracted:', receivedSignature);
    console.log('  - Expected:', expectedSignature);
    console.log('  - Match:', receivedSignature === expectedSignature);
    
    return receivedSignature === expectedSignature;
}

async function handlePaymentCompleted(paymentData) {
    try {
        console.log('✅ Payment completed - Full data:', JSON.stringify(paymentData, null, 2));
        
        // Extract data from Fungies.io structure
        const { payment, customer, items } = paymentData;
        const customer_id = customer?.id;
        const payment_id = payment?.id;
        const amount = payment?.value;
        
        // Extract product ID from items array - use offer.id instead of item.id
        // In Fungies.io: item.id = unique instance, offer.id = our configured product
        const product_id = items?.[0]?.offer?.id || items?.[0]?.productId;
        
        // Try to extract custom_data from various possible locations in Fungies.io webhook
        let custom_data = null;
        
        // Check different possible locations for custom data
        if (items?.[0]?.customFields) {
            custom_data = items[0].customFields;
            console.log('📦 Found customFields in items[0]:', custom_data);
        } else if (payment?.customFields) {
            custom_data = payment.customFields;
            console.log('📦 Found customFields in payment:', custom_data);
        } else if (paymentData?.customFields) {
            custom_data = paymentData.customFields;
            console.log('📦 Found customFields in paymentData:', custom_data);
        } else {
            console.log('📦 No custom_data found in webhook');
        }
        
        console.log('📦 Extracted data:');
        console.log('  - customer_id:', customer_id);
        console.log('  - product_id:', product_id);
        console.log('  - amount:', amount);
        console.log('  - payment_id:', payment_id);
        console.log('  - custom_data:', custom_data);
        console.log('  - items:', items);
        
        // For debugging: let's see what's in the items array
        if (items && items.length > 0) {
            console.log('📦 First item details:', JSON.stringify(items[0], null, 2));
        }
        
        let productType = null;
        console.log('🔍 Looking for product type for product_id:', product_id);
        for (const [type, product] of Object.entries(PRODUCTS)) {
            console.log(`  - Checking ${type}: ${product.productId}`);
            if (product.productId === product_id) {
                productType = type;
                console.log(`✅ Found matching product type: ${productType}`);
                break;
            }
        }

        if (!productType) {
            console.error('❌ Unknown product ID:', product_id);
            console.error('Available products:', Object.entries(PRODUCTS).map(([type, prod]) => `${type}: ${prod.productId}`));
            return;
        }
        
        console.log(`✅ Found product type: ${productType}`);
        
        // Try to find the Discord user ID from our pending payments
        console.log('🔍 Looking for Discord user ID in pending payments...');
        const pendingPayments = await readJSONFile(PAYMENTS_FILE);
        
        let userId = null;
        
        // First try to get from custom_data if available
        if (custom_data?.userId) {
            userId = custom_data.userId;
            console.log('✅ Found user ID from custom_data:', userId);
        } else {
            // Try to find matching payment by product type and timing
            const recentPayments = pendingPayments.filter(p => 
                p.status === 'pending' && 
                p.productType === productType &&
                Date.now() - new Date(p.createdAt).getTime() < 300000 // Within 5 minutes
            );
            
            console.log(`🔍 Found ${recentPayments.length} recent pending payments for ${productType}`);
            
            if (recentPayments.length > 0) {
                // Take the most recent one
                const mostRecent = recentPayments.sort((a, b) => 
                    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
                )[0];
                
                userId = mostRecent.userId;
                console.log('✅ Found user ID from recent payment:', userId);
            }
        }
        
        if (!userId) {
            console.error('❌ Could not determine Discord user ID from webhook or pending payments');
            console.error('❌ This payment cannot be processed automatically');
            return;
        }

        console.log('🔑 Generating license key...');
        const licenseKey = generateLicenseKey(userId, productType);
        const expirationDate = calculateExpirationDate(productType);
        console.log('✅ License key generated:', licenseKey);
        console.log('📅 Expiration date:', expirationDate.toISOString());

        console.log('💾 Saving license to database...');
        const licenses = await readJSONFile(LICENSES_FILE);
        const newLicense = {
            licenseKey,
            userId,
            productType,
            productId: product_id,
            paymentId: payment_id,
            isActive: true,
            createdAt: new Date().toISOString(),
            expirationDate: expirationDate.toISOString()
        };
        licenses.push(newLicense);
        await writeJSONFile(LICENSES_FILE, licenses);
        console.log('✅ License saved to database');

        console.log('🔄 Updating payment status...');
        const payments = await readJSONFile(PAYMENTS_FILE);
        const paymentIndex = payments.findIndex(p => p.paymentId === payment_id);
        if (paymentIndex !== -1) {
            payments[paymentIndex].status = 'completed';
            payments[paymentIndex].completedAt = new Date().toISOString();
            payments[paymentIndex].licenseKey = licenseKey;
            await writeJSONFile(PAYMENTS_FILE, payments);
            console.log('✅ Payment status updated');
        } else {
            console.log('⚠️ Payment record not found in database');
        }
        
        console.log('📨 Sending license key to user via DM...');
        await sendLicenseKeyToUser(userId, licenseKey, productType);

        console.log(`✅ License generated for user ${userId}: ${licenseKey}`);
    } catch (error) {
        console.error('❌ Error handling payment completion:', error);
    }
}

async function handlePaymentFailed(paymentData) {
    console.log('❌ Payment failed:', paymentData);
    
    const { payment_id, customer_id, reason } = paymentData;
    
    const payments = await readJSONFile(PAYMENTS_FILE);
    const paymentIndex = payments.findIndex(p => p.paymentId === payment_id);
    if (paymentIndex !== -1) {
        payments[paymentIndex].status = 'failed';
        payments[paymentIndex].failedAt = new Date().toISOString();
        payments[paymentIndex].failureReason = reason;
        await writeJSONFile(PAYMENTS_FILE, payments);
    }

    if (customer_id) {
        try {
            const user = await client.users.fetch(customer_id);
            const embed = new EmbedBuilder()
                .setTitle('❌ Payment Failed')
                .setDescription('Your payment could not be processed. Please try again or contact support.')
                .setColor(0xFF0000)
                .addFields({
                    name: 'Reason',
                    value: reason || 'Unknown error',
                    inline: false
                })
                .setTimestamp();

            await user.send({ embeds: [embed] });
        } catch (error) {
            console.error('Could not notify user about failed payment:', error);
        }
    }
}

async function handlePaymentRefunded(paymentData) {
    console.log('🔄 Payment refunded:', paymentData);
    
    const { payment_id, customer_id } = paymentData;
    
    const licenses = await readJSONFile(LICENSES_FILE);
    const licenseIndex = licenses.findIndex(l => l.paymentId === payment_id);
    if (licenseIndex !== -1) {
        licenses[licenseIndex].isActive = false;
        licenses[licenseIndex].refundedAt = new Date().toISOString();
        await writeJSONFile(LICENSES_FILE, licenses);
    }

    const payments = await readJSONFile(PAYMENTS_FILE);
    const paymentIndex = payments.findIndex(p => p.paymentId === payment_id);
    if (paymentIndex !== -1) {
        payments[paymentIndex].status = 'refunded';
        payments[paymentIndex].refundedAt = new Date().toISOString();
        await writeJSONFile(PAYMENTS_FILE, payments);
    }

    if (customer_id) {
        try {
            const user = await client.users.fetch(customer_id);
            const embed = new EmbedBuilder()
                .setTitle('🔄 Refund Processed')
                .setDescription('Your payment has been refunded and your license has been deactivated.')
                .setColor(0xFFA500)
                .setTimestamp();

            await user.send({ embeds: [embed] });
        } catch (error) {
            console.error('Could not notify user about refund:', error);
        }
    }
}

async function sendLicenseKeyToUser(userId, licenseKey, productType) {
    try {
        console.log(`📨 Attempting to send license key to user ${userId}`);
        console.log(`🔑 License key: ${licenseKey}`);
        console.log(`📦 Product type: ${productType}`);
        
        const user = await client.users.fetch(userId);
        console.log(`✅ User found: ${user.tag} (${user.id})`);
        
        const product = PRODUCTS[productType];
        console.log(`📦 Product details:`, product);
        
        const embed = new EmbedBuilder()
            .setTitle('🎉 Purchase Successful!')
            .setDescription('Thank you for your purchase! Here is your license key:')
            .setColor(0x00FF00)
            .addFields(
                {
                    name: '🔑 License Key',
                    value: `\`${licenseKey}\``,
                    inline: false
                },
                {
                    name: '📦 Product',
                    value: product.name,
                    inline: true
                },
                {
                    name: '⏰ Duration',
                    value: product.duration,
                    inline: true
                },
                {
                    name: '🎯 Redeem Your Key',
                    value: `Please redeem your key at: https://discord.com/channels/1381923242528477224/1381964183658037329/1393526095478919280`,
                    inline: false
                },
                {
                    name: '⚠️ Important',
                    value: 'Keep this license key safe! You can check your license status anytime using `/license`',
                    inline: false
                }
            )
            .setFooter({ text: 'Thank you for your business!' })
            .setTimestamp();

        console.log('📤 Sending DM to user...');
        await user.send({ embeds: [embed] });
        console.log(`✅ License key sent successfully to user ${userId} (${user.tag})`);
    } catch (error) {
        console.error('❌ Could not send license key to user:', error);
        console.error('Error details:', error.message);
    }
}

app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

app.get('/validate/:licenseKey', async (req, res) => {
    try {
        const { licenseKey } = req.params;
        const licenses = await readJSONFile(LICENSES_FILE);
        
        const license = licenses.find(l => l.licenseKey === licenseKey && l.isActive);
        
        if (!license) {
            return res.status(404).json({ valid: false, message: 'License not found' });
        }

        const expirationDate = new Date(license.expirationDate);
        const isExpired = expirationDate < new Date();

        if (isExpired) {
            return res.status(200).json({ 
                valid: false, 
                message: 'License expired',
                expirationDate: license.expirationDate
            });
        }

        res.status(200).json({
            valid: true,
            productType: license.productType,
            expirationDate: license.expirationDate,
            createdAt: license.createdAt
        });
    } catch (error) {
        console.error('Error validating license:', error);
        res.status(500).json({ valid: false, message: 'Internal server error' });
    }
});

app.listen(config.PORT, () => {
    console.log(`🌐 Webhook server running on port ${config.PORT}`);
});