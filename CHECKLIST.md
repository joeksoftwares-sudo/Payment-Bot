# Quick Deployment Checklist ✅

## Before Deployment
- [ ] Discord bot created and token obtained
- [ ] Discord application ID copied
- [ ] Bot invited to your Discord server
- [ ] Fungies.io account created and verified
- [ ] Three products created in Fungies.io (2 weeks, monthly, lifetime)
- [ ] Fungies.io API key generated
- [ ] Webhook secret created for Fungies.io

## Railway Deployment
- [ ] Railway account created
- [ ] Project created in Railway
- [ ] Code uploaded/connected to Railway
- [ ] **🔒 ALL Environment variables set in Railway (NOT in code):**
  - [ ] DISCORD_TOKEN (your actual bot token)
  - [ ] CLIENT_ID (your actual application ID)
  - [ ] ADMIN_USER_ID (your actual Discord user ID)
  - [ ] FUNGIES_API_KEY (your actual API key)
  - [ ] FUNGIES_WEBHOOK_SECRET (your actual webhook secret)
  - [ ] PRODUCT_ID_2WEEKS (your actual product ID)
  - [ ] PRODUCT_ID_MONTHLY (your actual product ID)
  - [ ] PRODUCT_ID_LIFETIME (your actual product ID)
  - [ ] WEBHOOK_URL (https://your-app.railway.app/webhook)
  - [ ] LICENSE_KEY_SECRET (strong random secret)
  - [ ] PORT (3000)
- [ ] Bot deployed successfully
- [ ] Railway URL obtained
- [ ] **Environment variables validation passed** (check Railway logs)

## Fungies.io Configuration
- [ ] Webhook URL set to: https://your-app.railway.app/webhook
- [ ] Webhook events enabled (payment.completed, payment.failed, payment.refunded)
- [ ] Webhook secret configured
- [ ] Test webhook sent successfully

## Testing
- [ ] Bot responds to commands in Discord
- [ ] `/buy` command works in DMs
- [ ] `/license` command shows correct status
- [ ] `/help` command displays properly
- [ ] Payment links generate correctly
- [ ] Test purchase completed successfully
- [ ] License key received automatically
- [ ] Webhook endpoint receiving data
- [ ] Health check endpoint working: https://your-app.railway.app/health

## Security Verification
- [ ] All secrets properly configured
- [ ] Webhook signature verification working
- [ ] Rate limiting functioning
- [ ] Anti-abuse measures active
- [ ] License validation endpoint working

## Go Live
- [ ] Update product prices if needed
- [ ] Customize bot branding/messages
- [ ] Monitor logs for first 24 hours
- [ ] Test with real payment (small amount)
- [ ] Set up monitoring/alerts

## Support Setup
- [ ] Create support documentation
- [ ] Set up user support channel
- [ ] Prepare FAQ responses
- [ ] Train support team on license system