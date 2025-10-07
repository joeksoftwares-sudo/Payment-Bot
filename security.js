const cron = require('node-cron');
const fs = require('fs').promises;
const path = require('path');

const DATA_DIR = './data';
const LICENSES_FILE = path.join(DATA_DIR, 'licenses.json');
const PAYMENTS_FILE = path.join(DATA_DIR, 'payments.json');

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

const rateLimit = new Map();
const userCooldowns = new Map();
const suspiciousActivity = new Map();

function checkRateLimit(userId, command, maxRequests = 5, windowMs = 60000) {
    const key = `${userId}:${command}`;
    const now = Date.now();
    
    if (!rateLimit.has(key)) {
        rateLimit.set(key, { count: 1, resetTime: now + windowMs });
        return true;
    }
    
    const userLimit = rateLimit.get(key);
    
    if (now > userLimit.resetTime) {
        rateLimit.set(key, { count: 1, resetTime: now + windowMs });
        return true;
    }
    
    if (userLimit.count >= maxRequests) {
        return false;
    }
    
    userLimit.count++;
    return true;
}

function checkPurchaseCooldown(userId, cooldownMs = 300000) {
    const now = Date.now();
    const lastPurchase = userCooldowns.get(userId);
    
    if (!lastPurchase || now - lastPurchase > cooldownMs) {
        userCooldowns.set(userId, now);
        return true;
    }
    
    return false;
}

function trackSuspiciousActivity(userId, activity) {
    const now = Date.now();
    const key = userId;
    
    if (!suspiciousActivity.has(key)) {
        suspiciousActivity.set(key, []);
    }
    
    const userActivity = suspiciousActivity.get(key);
    userActivity.push({ activity, timestamp: now });
    
    const dayAgo = now - 24 * 60 * 60 * 1000;
    suspiciousActivity.set(key, userActivity.filter(a => a.timestamp > dayAgo));
    
    if (userActivity.length > 20) {
        console.log(`⚠️ Suspicious activity detected for user ${userId}:`, userActivity);
        return true;
    }
    
    return false;
}

async function checkDuplicatePurchase(userId, productType) {
    const licenses = await readJSONFile(LICENSES_FILE);
    const payments = await readJSONFile(PAYMENTS_FILE);
    
    const recentPendingPayments = payments.filter(p => 
        p.userId === userId && 
        p.productType === productType && 
        p.status === 'pending' &&
        Date.now() - new Date(p.createdAt).getTime() < 600000
    );
    
    if (recentPendingPayments.length > 0) {
        return { isDuplicate: true, reason: 'Recent pending payment exists' };
    }
    
    const activeLicenses = licenses.filter(l => 
        l.userId === userId && 
        l.productType === productType && 
        l.isActive &&
        new Date(l.expirationDate) > new Date()
    );
    
    if (activeLicenses.length > 0 && productType !== 'lifetime') {
        return { isDuplicate: true, reason: 'Active license already exists' };
    }
    
    return { isDuplicate: false };
}

function validateUser(user) {
    const account = user;
    const now = Date.now();
    const accountAge = now - account.createdTimestamp;
    
    if (accountAge < 7 * 24 * 60 * 60 * 1000) {
        return { 
            isValid: false, 
            reason: 'Account too new', 
            requiresManualReview: true 
        };
    }
    
    const hasDefaultAvatar = !account.avatar;
    const hasSuspiciousName = /^.*(bot|test|fake|spam).*$/i.test(account.username);
    
    if (hasDefaultAvatar && hasSuspiciousName) {
        return { 
            isValid: false, 
            reason: 'Suspicious account characteristics',
            requiresManualReview: true 
        };
    }
    
    return { isValid: true };
}

function verifyLicenseIntegrity(licenseKey, userId, productType) {
    try {
        const [type, hash] = licenseKey.split('-');
        
        if (type !== productType.toUpperCase()) {
            return false;
        }
        
        return true;
    } catch (error) {
        return false;
    }
}

cron.schedule('0 0 * * *', async () => {
    console.log('🧹 Running daily cleanup...');
    
    try {
        const licenses = await readJSONFile(LICENSES_FILE);
        const now = new Date();
        
        let expiredCount = 0;
        licenses.forEach(license => {
            if (license.isActive && new Date(license.expirationDate) < now) {
                license.isActive = false;
                license.expiredAt = now.toISOString();
                expiredCount++;
            }
        });
        
        if (expiredCount > 0) {
            await writeJSONFile(LICENSES_FILE, licenses);
            console.log(`✅ Deactivated ${expiredCount} expired licenses`);
        }
        
        const hourAgo = Date.now() - 60 * 60 * 1000;
        for (const [key, data] of rateLimit.entries()) {
            if (data.resetTime < hourAgo) {
                rateLimit.delete(key);
            }
        }
        
        const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
        for (const [userId, timestamp] of userCooldowns.entries()) {
            if (timestamp < dayAgo) {
                userCooldowns.delete(userId);
            }
        }
        
        console.log('✅ Daily cleanup completed');
    } catch (error) {
        console.error('❌ Error during cleanup:', error);
    }
});

async function getSystemStats() {
    try {
        const licenses = await readJSONFile(LICENSES_FILE);
        const payments = await readJSONFile(PAYMENTS_FILE);
        
        const stats = {
            totalLicenses: licenses.length,
            activeLicenses: licenses.filter(l => l.isActive).length,
            totalPayments: payments.length,
            completedPayments: payments.filter(p => p.status === 'completed').length,
            pendingPayments: payments.filter(p => p.status === 'pending').length,
            failedPayments: payments.filter(p => p.status === 'failed').length,
            refundedPayments: payments.filter(p => p.status === 'refunded').length,
            currentRateLimits: rateLimit.size,
            userCooldowns: userCooldowns.size,
            suspiciousActivities: suspiciousActivity.size
        };
        
        return stats;
    } catch (error) {
        console.error('Error getting system stats:', error);
        return null;
    }
}

module.exports = {
    checkRateLimit,
    checkPurchaseCooldown,
    trackSuspiciousActivity,
    checkDuplicatePurchase,
    validateUser,
    verifyLicenseIntegrity,
    getSystemStats
};