# Complete Setup Guide - Discord Payment Bot

This guide will walk you through setting up your Discord payment bot with Fungies.io integration and Railway deployment.

## 📋 Prerequisites

- Discord account and server
- Fungies.io account
- Railway account
- Basic understanding of Discord bots

## 🚀 Step-by-Step Setup

### 1. Discord Bot Setup

#### 1.1 Create Discord Application
1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application"
3. Name your application (e.g., "Payment Bot")
4. Navigate to "Bot" section
5. Click "Add Bot"
6. Copy the **Bot Token** (keep this secret!)
7. Enable "Message Content Intent" under Privileged Gateway Intents

#### 1.2 Get Application ID
1. In the Discord Developer Portal, go to "General Information"
2. Copy your **Application ID**

#### 1.3 Invite Bot to Server
1. Go to "OAuth2" > "URL Generator"
2. Select scopes: `bot`, `applications.commands`
3. Select bot permissions: `Send Messages`, `Use Slash Commands`, `Read Message History`
4. Copy the generated URL and open it to invite the bot

### 2. Fungies.io Setup

#### 2.1 Create Fungies Account
1. Sign up at [Fungies.io](https://fungies.io)
2. Verify your account
3. Complete business verification if required

#### 2.2 Create Products
Create three digital products in Fungies.io:

**Product 1: 2 Weeks Access**
- Name: "2 Weeks Premium Access"
- Type: Digital Product
- Price: $9.99 (or your preferred price)
- Description: "Full access for 2 weeks"
- Copy the **Product ID**

**Product 2: Monthly Access**
- Name: "Monthly Premium Access"
- Type: Digital Product
- Price: $19.99 (or your preferred price)
- Description: "Full access for 1 month"
- Copy the **Product ID**

**Product 3: Lifetime Access**
- Name: "Lifetime Premium Access"
- Type: Digital Product
- Price: $99.99 (or your preferred price)
- Description: "Unlimited access forever"
- Copy the **Product ID**

#### 2.3 Get API Credentials
1. Go to Fungies.io Dashboard > Settings > API
2. Generate an **API Key**
3. Create a **Webhook Secret** (random secure string)
4. Note down both values

### 3. Railway Deployment

#### 3.1 Prepare Your Code
1. Download/clone this bot code
2. Make sure all files are present:
   - `index.js`
   - `security.js`
   - `package.json`
   - `railway.json`
   - `.gitignore`

#### 3.2 Deploy to Railway
1. Sign up at [Railway](https://railway.app)
2. Create new project
3. Connect your GitHub repository OR upload files directly
4. Railway will automatically detect Node.js and install dependencies

#### 3.3 Set Environment Variables in Railway ⚠️ CRITICAL STEP

**IMPORTANT:** All sensitive information MUST be stored as environment variables in Railway. Never hardcode secrets in your application code.

In Railway dashboard, go to your project → **Variables** tab and add these variables with your actual values:

**Required Variables:**
```
DISCORD_TOKEN = your_actual_discord_bot_token
CLIENT_ID = your_actual_discord_application_id
ADMIN_USER_ID = your_actual_discord_user_id
FUNGIES_API_KEY = your_actual_fungies_api_key
FUNGIES_WEBHOOK_SECRET = your_actual_webhook_secret
PRODUCT_ID_2WEEKS = your_actual_2weeks_product_id
PRODUCT_ID_MONTHLY = your_actual_monthly_product_id
PRODUCT_ID_LIFETIME = your_actual_lifetime_product_id
WEBHOOK_URL = payment-bot-production.up.railway.app/webhook
LICENSE_KEY_SECRET = your_random_secret_for_license_generation
PORT = 3000
```

**Security Notes:**
- ⚠️ Replace ALL placeholder values with your actual credentials
- 🔒 Never commit real values to version control
- 🔄 The bot will fail to start if any required variables are missing
- 📝 Use the `.env.example` file as a reference for variable names only

**How to add variables in Railway:**
1. Open your Railway project dashboard
2. Click the **"Variables"** tab
3. Click **"New Variable"**
4. Add variable name and value
5. Repeat for all variables above
6. Deploy your application

#### 3.4 Get Railway URL
1. After deployment, Railway will provide a URL like: `https://your-app-name.railway.app`
2. Copy this URL - you'll need it for webhooks

### 4. Configure Fungies.io Webhooks

#### 4.1 Set Webhook URL
1. In Fungies.io Dashboard, go to Settings > Webhooks
2. Set Webhook URL to: `https://your-railway-app-url.railway.app/webhook`
3. Select events to send:
   - `payment.completed`
   - `payment.failed`
   - `payment.refunded`
4. Set the webhook secret you created earlier
5. Save the configuration

#### 4.2 Test Webhook
1. Fungies.io should provide a way to test webhooks
2. Send a test webhook to ensure connectivity
3. Check Railway logs to see if webhook is received

### 5. Final Configuration

#### 5.1 Update Payment URLs
In the bot code, you need to integrate actual Fungies.io payment URLs. The current code has placeholder URLs that need to be replaced with real Fungies.io payment links.

**Modify the `handlePurchase` function in `index.js`:**

Replace this line:
```javascript
const paymentUrl = `https://fungies.io/pay/${product.productId}?user=${interaction.user.id}&payment=${paymentId}`;
```

With the actual Fungies.io payment URL format (check Fungies.io documentation for exact format):
```javascript
const paymentUrl = `https://fungies.io/checkout/${product.productId}?custom_data=${JSON.stringify({userId: interaction.user.id, paymentId: paymentId})}`;
```

#### 5.2 Test the Bot
1. Send a DM to your bot
2. Use `/buy` command
3. Try making a test purchase
4. Verify that license keys are generated and sent

## 🔧 Configuration Options

### Pricing
Modify the `PRODUCTS` object in `index.js` to change pricing:

```javascript
const PRODUCTS = {
    '2weeks': {
        name: '2 Weeks Access',
        price: '$9.99',  // Change this
        description: 'Full access for 2 weeks',
        productId: config.PRODUCT_ID_2WEEKS,
        duration: '14 days'
    },
    // ... other products
};
```

### Anti-Abuse Settings
Modify security settings in `security.js`:

```javascript
// Rate limiting: 3 requests per minute for /buy command
if (!checkRateLimit(userId, 'buy', 3, 60000))

// Purchase cooldown: 5 minutes between purchases
if (!checkPurchaseCooldown(userId, 300000))
```

### License Key Format
Modify license key generation in `index.js`:

```javascript
function generateLicenseKey(userId, productType) {
    // Customize the format here
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 15);
    const data = `${userId}-${productType}-${timestamp}-${random}`;
    const hash = crypto.createHmac('sha256', config.LICENSE_KEY_SECRET).update(data).digest('hex').substring(0, 16);
    return `${productType.toUpperCase()}-${hash.toUpperCase()}`;
}
```

## 🛡️ Security Best Practices

### 1. Environment Variables
- Never commit `.env` files
- Use strong, random secrets
- Rotate webhook secrets regularly

### 2. Webhook Security
- Always verify webhook signatures
- Use HTTPS only
- Log suspicious activities

### 3. Rate Limiting
- Monitor for unusual activity patterns
- Adjust rate limits based on usage
- Implement IP-based limiting if needed

### 4. License Security
- Use strong HMAC secrets
- Implement license verification in your main application
- Monitor for license sharing

## 🔍 Monitoring and Maintenance

### Daily Tasks
- Check Railway logs for errors
- Monitor license generation
- Review suspicious activity logs

### Weekly Tasks
- Review payment statistics
- Check for expired licenses
- Update abuse prevention rules if needed

### Monthly Tasks
- Rotate secrets if needed
- Review and optimize database
- Update dependencies

## 📊 Using the License Validation API

Your bot exposes a license validation endpoint at:
```
GET https://your-railway-app-url.railway.app/validate/{licenseKey}
```

Response format:
```json
{
  "valid": true,
  "productType": "monthly",
  "expirationDate": "2024-01-15T10:30:00.000Z",
  "createdAt": "2023-12-15T10:30:00.000Z"
}
```

Integrate this into your main application to verify user licenses.

## 🆘 Troubleshooting

### Bot Not Responding
1. Check Railway logs for errors
2. Verify Discord token is correct
3. Ensure bot has necessary permissions
4. Check if bot is online in Discord

### Webhook Not Working
1. Verify webhook URL is correct
2. Check Fungies.io webhook logs
3. Verify webhook secret matches
4. Test webhook endpoint manually

### License Keys Not Generated
1. Check Railway logs for webhook errors
2. Verify product IDs match Fungies.io
3. Check webhook signature verification
4. Ensure file permissions for data directory

### Payment Links Not Working
1. Verify Fungies.io product IDs
2. Check payment URL format
3. Ensure products are active in Fungies.io
4. Test payment flow manually

## 🚀 Advanced Features

### Database Integration
For production use, consider switching from JSON files to a proper database:

1. **PostgreSQL** (recommended for Railway)
2. **MongoDB**
3. **SQLite** (for smaller deployments)

### Multiple Servers
To support multiple Discord servers:

1. Add guild ID tracking
2. Implement per-server configuration
3. Add admin commands for server management

### Analytics
Add analytics tracking:

1. Payment conversion rates
2. Popular products
3. User behavior patterns
4. Revenue tracking

### Custom Branding
Customize the bot for your brand:

1. Change embed colors
2. Add custom logos
3. Modify message content
4. Add branded footer text

## 📝 Additional Ideas and Features

### Subscription Management
- Add `/cancel` command for subscription cancellation
- Implement subscription renewal reminders
- Add pause/resume functionality

### Referral System
- Generate referral codes
- Track referral earnings
- Implement referral rewards

### Coupon System
- Create discount codes
- Time-limited promotions
- Bulk purchase discounts

### User Dashboard
- Web interface for license management
- Purchase history
- Download receipts

### Advanced Anti-Abuse
- IP tracking and limiting
- Device fingerprinting
- Machine learning fraud detection
- Chargeback protection

---

**Need Help?** Join our support server or create an issue in the GitHub repository.

**Security Notice:** Always keep your tokens, API keys, and secrets secure. Never share them publicly.