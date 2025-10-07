# 🔒 Security & Environment Variables Guide

## ⚠️ CRITICAL: Never Hardcode Secrets

**The bot code now requires ALL sensitive information to be stored as environment variables.** This prevents accidental exposure of secrets and follows security best practices.

## 🚫 What NOT to Do

```javascript
// ❌ NEVER do this - secrets exposed in code
const config = {
    DISCORD_TOKEN: 'OTk2MjY4NjE4MTY1Njc4NTky.G3x4KW.example_token_here',
    FUNGIES_API_KEY: 'fgk_live_abcd1234567890',
    // ... other secrets
};
```

## ✅ What TO Do

```javascript
// ✅ CORRECT - load from environment variables
const config = {
    DISCORD_TOKEN: process.env.DISCORD_TOKEN,
    FUNGIES_API_KEY: process.env.FUNGIES_API_KEY,
    // ... other variables
};
```

## 🔧 Environment Variable Setup

### Railway (Production)
1. **Railway Dashboard** → Your Project → **Variables**
2. Add each variable with **actual values** (not placeholders)
3. Variables are encrypted and secure in Railway

### Local Development (Optional)
If testing locally, create a `.env` file:
```bash
# .env file (NEVER commit this!)
DISCORD_TOKEN=your_actual_token_here
CLIENT_ID=your_actual_client_id_here
# ... etc
```

## 🛡️ Security Features Added

### Environment Variable Validation
The bot now validates all required environment variables on startup:
- ✅ Checks if all required variables are present
- ❌ Exits with error message if any are missing
- 📝 Lists exactly which variables need to be set

### Error Messages
If variables are missing, you'll see:
```
❌ Missing required environment variables:
   - DISCORD_TOKEN
   - FUNGIES_API_KEY
   - ADMIN_USER_ID

🔧 Please set these environment variables in Railway or your .env file
📖 See SETUP.md for detailed configuration instructions
```

### Secret Rotation
To change any secret:
1. **Update in Railway Variables** (not code)
2. **Restart the application**
3. **Old secret is immediately invalid**

## 🔑 Best Practices

### Strong Secrets
- **Discord Token**: Provided by Discord (keep secure)
- **API Keys**: Provided by services (never share)
- **License Secret**: Generate random 32+ character string
- **Webhook Secret**: Generate random 32+ character string

### Secret Management
- 🔒 **Store only in environment variables**
- 🚫 **Never commit secrets to git**
- 📝 **Use `.env.example` for reference only**
- 🔄 **Rotate secrets periodically**
- 👥 **Limit access to who can see Railway variables**

### Railway Security
- ✅ Railway encrypts environment variables
- ✅ Variables are not exposed in logs
- ✅ Only project collaborators can access
- ✅ Variables persist through deployments

## 🚨 If Secrets Are Compromised

### Immediate Actions:
1. **Regenerate the compromised secret**
2. **Update Railway environment variables**
3. **Restart the application**
4. **Monitor for unauthorized access**

### Discord Token Compromised:
1. **Discord Developer Portal** → Your App → **Bot** → **Reset Token**
2. **Update DISCORD_TOKEN in Railway**
3. **Restart bot**

### API Key Compromised:
1. **Regenerate API key** in the service (Fungies.io)
2. **Update variable in Railway**
3. **Restart application**

## 📋 Environment Variables Quick Reference

```bash
# Required Variables (replace with actual values)
DISCORD_TOKEN=your_actual_bot_token
CLIENT_ID=your_actual_application_id
ADMIN_USER_ID=your_actual_discord_user_id
FUNGIES_API_KEY=your_actual_api_key
FUNGIES_WEBHOOK_SECRET=your_actual_webhook_secret
PRODUCT_ID_2WEEKS=your_actual_product_id
PRODUCT_ID_MONTHLY=your_actual_product_id
PRODUCT_ID_LIFETIME=your_actual_product_id
WEBHOOK_URL=https://your-app.railway.app/webhook
LICENSE_KEY_SECRET=your_random_32_char_secret
PORT=3000
```

## 🔍 Verification

After setting variables, check Railway logs for:
```
✅ All required environment variables are set
🚀 Starting Discord bot...
✅ Bot is ready! Logged in as YourBot#1234
```

**Remember:** Security is not optional. Always use environment variables for sensitive data!