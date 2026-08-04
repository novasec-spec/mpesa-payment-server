require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());

// ==============================
// 📁 Logging & Storage Setup
// ==============================

const TRANSACTIONS_FILE = path.join(__dirname, 'transactions.json');
const LOG_FILE = path.join(__dirname, 'logs', 'transactions.log');

// Create logs directory if it doesn't exist
if (!fs.existsSync(path.join(__dirname, 'logs'))) {
    fs.mkdirSync(path.join(__dirname, 'logs'));
}

// Initialize transactions file if it doesn't exist
if (!fs.existsSync(TRANSACTIONS_FILE)) {
    fs.writeFileSync(TRANSACTIONS_FILE, JSON.stringify({ transactions: [] }, null, 2));
}

// ==============================
// 📝 Logger Functions
// ==============================

function logToFile(message, type = 'INFO') {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] [${type}] ${message}\n`;
    fs.appendFileSync(LOG_FILE, logEntry);
    console.log(logEntry.trim());
}

function logTransaction(transaction) {
    // Read existing transactions
    const data = JSON.parse(fs.readFileSync(TRANSACTIONS_FILE, 'utf8'));
    data.transactions.push({
        ...transaction,
        timestamp: new Date().toISOString()
    });
    fs.writeFileSync(TRANSACTIONS_FILE, JSON.stringify(data, null, 2));
}

// ==============================
// 🔐 M-Pesa Configuration
// ==============================

const MPESA_BASE_URL = process.env.MPESA_ENVIRONMENT === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';

const CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET;
const SHORTCODE = process.env.MPESA_SHORTCODE;
const PASSKEY = process.env.MPESA_PASSKEY;
const CALLBACK_URL = process.env.CALLBACK_URL;

// ==============================
// 🔑 Generate Access Token
// ==============================

async function getAccessToken() {
    const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');
    
    logToFile('🔄 Attempting to get access token...', 'AUTH');
    
    try {
        const response = await axios.get(
            `${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
            {
                headers: {
                    Authorization: `Basic ${auth}`
                }
            }
        );
        
        logToFile('✅ Access token generated successfully', 'AUTH');
        return response.data.access_token;
    } catch (error) {
        logToFile(`❌ Error generating token: ${error.response?.data?.error_description || error.message}`, 'ERROR');
        throw error;
    }
}

// ==============================
// 💰 Initiate STK Push
// ==============================

app.post('/api/stk-push', async (req, res) => {
    try {
        const { phone, amount } = req.body;

        logToFile('========================================', 'PAYMENT');
        logToFile(`📱 New payment request: Phone: ${phone}, Amount: ${amount}`, 'PAYMENT');

        // Validate input
        if (!phone || !amount) {
            return res.status(400).json({
                success: false,
                message: 'Phone number and amount are required'
            });
        }

        // Format phone number
        let formattedPhone = phone.replace(/\s/g, '');
        if (formattedPhone.startsWith('0')) {
            formattedPhone = '254' + formattedPhone.slice(1);
        } else if (formattedPhone.startsWith('+')) {
            formattedPhone = formattedPhone.slice(1);
        }

        logToFile(`📱 Formatted phone: ${formattedPhone}`, 'PAYMENT');

        // Get access token
        const token = await getAccessToken();

        // Generate timestamp and password
        const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
        const password = Buffer.from(`${SHORTCODE}${PASSKEY}${timestamp}`).toString('base64');

        // Prepare STK Push payload
        const checkoutRequestID = `CHK${Date.now()}`;
        const payload = {
            BusinessShortCode: SHORTCODE,
            Password: password,
            Timestamp: timestamp,
            TransactionType: 'CustomerPayBillOnline',
            Amount: amount.toString(),
            PartyA: formattedPhone,
            PartyB: SHORTCODE,
            PhoneNumber: formattedPhone,
            CallBackURL: CALLBACK_URL,
            AccountReference: `INV${Date.now()}`,
            TransactionDesc: 'Payment for services'
        };

        logToFile(`📤 Sending STK Push request...`, 'PAYMENT');
        logToFile(`📦 Payload: ${JSON.stringify(payload, null, 2)}`, 'DEBUG');

        // Send STK Push request
        const response = await axios.post(
            `${MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest`,
            payload,
            {
                headers: {
                    Authorization: `Bearer ${token}`
                }
            }
        );

        const responseData = response.data;
        
        // Log the response
        logToFile(`📥 STK Push response: ${JSON.stringify(responseData, null, 2)}`, 'PAYMENT');

        // Save transaction to database
        const transaction = {
            checkoutRequestID: responseData.CheckoutRequestID,
            merchantRequestID: responseData.MerchantRequestID,
            phoneNumber: formattedPhone,
            amount: amount,
            status: 'PENDING',
            responseCode: responseData.ResponseCode,
            responseDescription: responseData.ResponseDescription,
            customerMessage: responseData.CustomerMessage,
            createdAt: new Date().toISOString()
        };

        logTransaction(transaction);
        logToFile(`💾 Transaction saved with ID: ${transaction.checkoutRequestID}`, 'DB');

        res.json({
            success: true,
            message: 'STK Push sent successfully',
            data: responseData
        });

    } catch (error) {
        logToFile(`❌ STK Push error: ${error.response?.data || error.message}`, 'ERROR');
        res.status(500).json({
            success: false,
            message: 'Payment initiation failed',
            error: error.response?.data || error.message
        });
    }
});

// ==============================
// 📩 Callback Endpoint - ALL STATES
// ==============================

app.post('/api/callback', (req, res) => {
    logToFile('========================================', 'CALLBACK');
    logToFile(`📩 Callback received: ${JSON.stringify(req.body, null, 2)}`, 'CALLBACK');
    
    try {
        const callback = req.body.Body.stkCallback;
        const resultCode = callback.ResultCode;
        const resultDesc = callback.ResultDesc;
        const checkoutRequestID = callback.CheckoutRequestID;
        const merchantRequestID = callback.MerchantRequestID;

        // Determine transaction status
        let status = 'UNKNOWN';
        let statusMessage = '';

        // ============================================
        // 🎯 HANDLE ALL POSSIBLE RESULT CODES
        // ============================================
        
        if (resultCode === 0) {
            // ✅ SUCCESSFUL TRANSACTION
            status = 'COMPLETED';
            statusMessage = '✅ Payment successful!';
            
            const metadata = callback.CallbackMetadata.Item;
            const receipt = metadata.find(item => item.Name === 'MpesaReceiptNumber')?.Value;
            const amount = metadata.find(item => item.Name === 'Amount')?.Value;
            const phone = metadata.find(item => item.Name === 'PhoneNumber')?.Value;
            const transactionDate = metadata.find(item => item.Name === 'TransactionDate')?.Value;
            
            logToFile(`✅ SUCCESS - Receipt: ${receipt}, Amount: KES ${amount}, Phone: ${phone}`, 'CALLBACK');
            
            // Update transaction in database
            updateTransaction(checkoutRequestID, {
                status: 'COMPLETED',
                resultCode: resultCode,
                resultDesc: resultDesc,
                receiptNumber: receipt,
                amount: amount,
                phoneNumber: phone,
                transactionDate: transactionDate,
                completedAt: new Date().toISOString()
            });

        } else if (resultCode === 1032) {
            // ❌ CANCELED BY USER
            status = 'CANCELED';
            statusMessage = '❌ Transaction canceled by user';
            logToFile(`❌ CANCELED - User canceled the transaction`, 'CALLBACK');
            
            updateTransaction(checkoutRequestID, {
                status: 'CANCELED',
                resultCode: resultCode,
                resultDesc: resultDesc,
                canceledAt: new Date().toISOString()
            });

        } else if (resultCode === 1037) {
            // ❌ INSUFFICIENT BALANCE
            status = 'INSUFFICIENT_BALANCE';
            statusMessage = '❌ Insufficient balance in customer account';
            logToFile(`❌ INSUFFICIENT BALANCE - Customer has insufficient funds`, 'CALLBACK');
            
            updateTransaction(checkoutRequestID, {
                status: 'INSUFFICIENT_BALANCE',
                resultCode: resultCode,
                resultDesc: resultDesc,
                failedAt: new Date().toISOString()
            });

        } else if (resultCode === 1) {
            // ❌ REJECTED BY SYSTEM
            status = 'REJECTED';
            statusMessage = '❌ Transaction rejected by system';
            logToFile(`❌ REJECTED - System rejected the transaction`, 'CALLBACK');
            
            updateTransaction(checkoutRequestID, {
                status: 'REJECTED',
                resultCode: resultCode,
                resultDesc: resultDesc,
                failedAt: new Date().toISOString()
            });

        } else if (resultCode === 1021) {
            // ⏰ TIMEOUT
            status = 'TIMEOUT';
            statusMessage = '⏰ Transaction timed out';
            logToFile(`⏰ TIMEOUT - Transaction took too long`, 'CALLBACK');
            
            updateTransaction(checkoutRequestID, {
                status: 'TIMEOUT',
                resultCode: resultCode,
                resultDesc: resultDesc,
                failedAt: new Date().toISOString()
            });

        } else if (resultCode === 2001) {
            // ❌ INVALID AMOUNT
            status = 'INVALID_AMOUNT';
            statusMessage = '❌ Invalid amount entered';
            logToFile(`❌ INVALID AMOUNT - Customer entered invalid amount`, 'CALLBACK');
            
            updateTransaction(checkoutRequestID, {
                status: 'INVALID_AMOUNT',
                resultCode: resultCode,
                resultDesc: resultDesc,
                failedAt: new Date().toISOString()
            });

        } else if (resultCode === 2006) {
            // ❌ INVALID PHONE NUMBER
            status = 'INVALID_PHONE';
            statusMessage = '❌ Invalid phone number';
            logToFile(`❌ INVALID PHONE - Phone number is invalid`, 'CALLBACK');
            
            updateTransaction(checkoutRequestID, {
                status: 'INVALID_PHONE',
                resultCode: resultCode,
                resultDesc: resultDesc,
                failedAt: new Date().toISOString()
            });

        } else if (resultCode === 2009) {
            // ❌ TRANSACTION NOT FOUND
            status = 'NOT_FOUND';
            statusMessage = '❌ Transaction not found';
            logToFile(`❌ NOT FOUND - Transaction could not be found`, 'CALLBACK');
            
            updateTransaction(checkoutRequestID, {
                status: 'NOT_FOUND',
                resultCode: resultCode,
                resultDesc: resultDesc,
                failedAt: new Date().toISOString()
            });

        } else {
            // ❓ UNKNOWN ERROR
            status = 'FAILED';
            statusMessage = `❌ Unknown error: ${resultCode} - ${resultDesc}`;
            logToFile(`❌ UNKNOWN ERROR - Code: ${resultCode}, Desc: ${resultDesc}`, 'CALLBACK');
            
            updateTransaction(checkoutRequestID, {
                status: 'FAILED',
                resultCode: resultCode,
                resultDesc: resultDesc,
                failedAt: new Date().toISOString()
            });
        }

        // Log the final status
        logToFile(`📊 Transaction ${checkoutRequestID} final status: ${status}`, 'CALLBACK');
        logToFile(`📝 ${statusMessage}`, 'CALLBACK');
        logToFile('========================================', 'CALLBACK');

        // Always respond with 200 to acknowledge receipt
        res.status(200).json({ ResultCode: 0, ResultDesc: 'Success' });

    } catch (error) {
        logToFile(`❌ Error processing callback: ${error.message}`, 'ERROR');
        res.status(200).json({ ResultCode: 0, ResultDesc: 'Success' });
    }
});

// ==============================
// 📊 Transaction Update Function
// ==============================

function updateTransaction(checkoutRequestID, updates) {
    try {
        const data = JSON.parse(fs.readFileSync(TRANSACTIONS_FILE, 'utf8'));
        const index = data.transactions.findIndex(t => t.checkoutRequestID === checkoutRequestID);
        
        if (index !== -1) {
            data.transactions[index] = {
                ...data.transactions[index],
                ...updates,
                updatedAt: new Date().toISOString()
            };
            fs.writeFileSync(TRANSACTIONS_FILE, JSON.stringify(data, null, 2));
            logToFile(`💾 Transaction ${checkoutRequestID} updated in database`, 'DB');
        } else {
            // If transaction doesn't exist, create it
            data.transactions.push({
                checkoutRequestID,
                ...updates,
                createdAt: new Date().toISOString()
            });
            fs.writeFileSync(TRANSACTIONS_FILE, JSON.stringify(data, null, 2));
            logToFile(`💾 New transaction ${checkoutRequestID} created`, 'DB');
        }
    } catch (error) {
        logToFile(`❌ Error updating transaction: ${error.message}`, 'ERROR');
    }
}

// ==============================
// 🔍 Query Transaction Status
// ==============================

app.get('/api/transaction/:id', (req, res) => {
    const { id } = req.params;
    
    try {
        const data = JSON.parse(fs.readFileSync(TRANSACTIONS_FILE, 'utf8'));
        const transaction = data.transactions.find(t => 
            t.checkoutRequestID === id || 
            t.merchantRequestID === id ||
            t.receiptNumber === id
        );
        
        if (transaction) {
            res.json({
                success: true,
                transaction: transaction
            });
        } else {
            res.status(404).json({
                success: false,
                message: 'Transaction not found'
            });
        }
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Error fetching transaction'
        });
    }
});

// ==============================
// 📊 Get All Transactions
// ==============================

app.get('/api/transactions', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(TRANSACTIONS_FILE, 'utf8'));
        res.json({
            success: true,
            total: data.transactions.length,
            transactions: data.transactions
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Error fetching transactions'
        });
    }
});

// ==============================
// 📊 Get Transaction Statistics
// ==============================

app.get('/api/stats', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(TRANSACTIONS_FILE, 'utf8'));
        const transactions = data.transactions;
        
        const stats = {
            total: transactions.length,
            byStatus: {
                COMPLETED: transactions.filter(t => t.status === 'COMPLETED').length,
                PENDING: transactions.filter(t => t.status === 'PENDING').length,
                CANCELED: transactions.filter(t => t.status === 'CANCELED').length,
                INSUFFICIENT_BALANCE: transactions.filter(t => t.status === 'INSUFFICIENT_BALANCE').length,
                REJECTED: transactions.filter(t => t.status === 'REJECTED').length,
                TIMEOUT: transactions.filter(t => t.status === 'TIMEOUT').length,
                FAILED: transactions.filter(t => t.status === 'FAILED').length
            },
            totalAmount: transactions
                .filter(t => t.status === 'COMPLETED')
                .reduce((sum, t) => sum + (parseFloat(t.amount) || 0), 0),
            successRate: transactions.length > 0 
                ? `${((transactions.filter(t => t.status === 'COMPLETED').length / transactions.length) * 100).toFixed(2)}%`
                : '0%'
        };
        
        res.json({
            success: true,
            stats: stats
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Error fetching stats'
        });
    }
});

// ==============================
// 🧹 Clear All Transactions (for testing)
// ==============================

app.delete('/api/transactions', (req, res) => {
    try {
        fs.writeFileSync(TRANSACTIONS_FILE, JSON.stringify({ transactions: [] }, null, 2));
        logToFile('🧹 All transactions cleared', 'ADMIN');
        res.json({
            success: true,
            message: 'All transactions cleared'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Error clearing transactions'
        });
    }
});

// ==============================
// 🚀 Start Server
// ==============================

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
    logToFile('========================================', 'STARTUP');
    logToFile(`🚀 M-Pesa Monitor Server running on port ${PORT}`, 'STARTUP');
    logToFile(`📍 http://localhost:${PORT}`, 'STARTUP');
    logToFile(`📊 Transaction logs: ${LOG_FILE}`, 'STARTUP');
    logToFile(`💾 Transaction DB: ${TRANSACTIONS_FILE}`, 'STARTUP');
    logToFile('========================================', 'STARTUP');
    
    // Test credentials on startup
    try {
        await getAccessToken();
        logToFile('✅ Credentials are valid! Ready for payments.', 'STARTUP');
    } catch (error) {
        logToFile('❌ Credentials test failed! Check your .env file.', 'ERROR');
    }
});
