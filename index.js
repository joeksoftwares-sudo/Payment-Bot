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

const PRODUCTS = {
    '2weeks': {
        name: '2 Weeks Access',
        price: '$6.99 + taxes',
        description: 'Full access for 2 weeks',
        productId: config.PRODUCT_ID_2WEEKS,
        duration: '14 days'
    },
    'monthly': {
        name: 'Monthly Access',
        price: '$11 + taxes',
        description: 'Full access for 1 month',
        productId: config.PRODUCT_ID_MONTHLY,
        duration: '30 days'
    },
    'lifetime': {
        name: 'Lifetime Access',
        price: '$22 + taxes',
        description: 'Unlimited access forever',
        productId: config.PRODUCT_ID_LIFETIME,
        duration: 'Forever'
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
        .setDescription('Choose your subscription plan:')
        .setColor(0x00AE86)
        .addFields(
            {
                name: '📅 2 Weeks Access',
                value: `**${PRODUCTS['2weeks'].price}**\n${PRODUCTS['2weeks'].description}`,
                inline: true
            },
            {
                name: '📅 Monthly Access',
                value: `**${PRODUCTS['monthly'].price}**\n${PRODUCTS['monthly'].description}`,
                inline: true
            },
            {
                name: '♾️ Lifetime Access',
                value: `**${PRODUCTS['lifetime'].price}**\n${PRODUCTS['lifetime'].description}`,
                inline: true
            }
        )
        .setFooter({ text: 'Click a button below to proceed with payment' })
        .setTimestamp();

    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('buy_2weeks')
                .setLabel('2 Weeks - ' + PRODUCTS['2weeks'].price)
                .setStyle(ButtonStyle.Primary)
                .setEmoji('📅'),
            new ButtonBuilder()
                .setCustomId('buy_monthly')
                .setLabel('Monthly - ' + PRODUCTS['monthly'].price)
                .setStyle(ButtonStyle.Primary)
                .setEmoji('📅'),
            new ButtonBuilder()
                .setCustomId('buy_lifetime')
                .setLabel('Lifetime - ' + PRODUCTS['lifetime'].price)
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

    const [action, productType] = interaction.customId.split('_');
    
    if (action === 'buy') {
        await handlePurchase(interaction, productType);
    }
});

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
    
    return signature === expectedSignature;
}

async function handlePaymentCompleted(paymentData) {
    try {
        console.log('✅ Payment completed - Full data:', JSON.stringify(paymentData, null, 2));
        
        // Extract data from Fungies.io structure
        const { payment, customer, items } = paymentData;
        const customer_id = customer?.id;
        const payment_id = payment?.id;
        const amount = payment?.value;
        
        // Extract product ID from items array (assuming first item)
        const product_id = items?.[0]?.id || items?.[0]?.productId;
        
        // Try to extract custom_data from payment URL or other sources
        // For now, we'll rely on customer_id since custom_data might not be available
        const custom_data = null; // We'll need to get Discord user ID differently
        
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