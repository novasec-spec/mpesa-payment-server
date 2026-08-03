require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// M-Pesa configuration
const MPESA_BASE_URL = process.env.MPESA_ENVIRONMENT === 'production' 
    ? 'https://api.safaricom.co.ke' 
    : 'https://sandbox.safaricom.co.ke';

const CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET;
const SHORTCODE = process.env.MPESA_SHORTCODE;
const PASSKEY = process.env.MPESA_PASSKEY;
const CALLBACK_URL = process.env.CALLBACK_URL;

// Validate environment variables
if (!CONSUMER_KEY || !CONSUMER_SECRET) {
    console.error('❌ MPESA_CONSUMER_KEY and MPESA_CONSUMER_SECRET are required');
    console.error('Please check your .env file');
    process.exit(1);
}

console.log('✅ Environment configuration loaded:');
console.log(`   Environment: ${process.env.MPESA_ENVIRONMENT}`);
console.log(`   Consumer Key: ${CONSUMER_KEY.substring(0, 10)}...`);

// Generate OAuth token with detailed error handling
async function getAccessToken() {
    const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');
    
    console.log('🔄 Attempting to get access token...');
    console.log(`   URL: ${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`);
    
    try {
        const response = await axios.get(
            `${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
            {
                headers: {
                    Authorization: `Basic ${auth}`
                }
            }
        );
        
        console.log('✅ Access token generated successfully');
        return response.data.access_token;
    } catch (error) {
        // Enhanced error logging
        console.error('❌ Error generating token:');
        
        if (error.response) {
            // The request was made and the server responded with a status code
            console.error(`   Status: ${error.response.status}`);
            console.error(`   Headers:`, error.response.headers);
            console.error(`   Response Data:`, error.response.data);
            
            // Specific error messages
            if (error.response.status === 400) {
                console.error(`   💡 Possible causes:`);
                console.error(`      - Invalid Consumer Key or Secret`);
                console.error(`      - Sandbox credentials used in production (or vice versa)`);
                console.error(`      - Credentials not activated on Daraja portal`);
                console.error(`   🔧 Solutions:`);
                console.error(`      1. Verify your credentials on developer.safaricom.co.ke`);
                console.error(`      2. Ensure the app is "Live" in sandbox`);
                console.error(`      3. Check for extra spaces in your .env file`);
            }
        } else if (error.request) {
            // The request was made but no response was received
            console.error('   No response received from server');
            console.error('   💡 Check your internet connection');
        } else {
            // Something happened in setting up the request
            console.error(`   Error: ${error.message}`);
        }
        
        throw error;
    }
}

// Test token generation on startup
async function testCredentials() {
    try {
        console.log('🔐 Testing M-Pesa credentials...');
        await getAccessToken();
        console.log('✅ Credentials are valid!');
    } catch (error) {
        console.error('❌ Credentials test failed!');
        console.error('Please fix your .env file and restart the server');
        process.exit(1);
    }
}

// STK Push endpoint
app.post('/api/stk-push', async (req, res) => {
    try {
        const { phone, amount } = req.body;

        console.log(`📱 Payment request: Phone: ${phone}, Amount: ${amount}`);

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

        console.log(`   Formatted phone: ${formattedPhone}`);

        // Get access token
        const token = await getAccessToken();

        // Generate timestamp and password
        const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
        const password = Buffer.from(`${SHORTCODE}${PASSKEY}${timestamp}`).toString('base64');

        console.log(`   Timestamp: ${timestamp}`);
        console.log(`   Shortcode: ${SHORTCODE}`);

        // Prepare STK Push payload
        const payload = {
            BusinessShortCode: SHORTCODE,
            Password: password,
            Timestamp: timestamp,
            TransactionType: 'CustomerPayBillOnline',
            Amount: amount.toString(),
            PartyA: formattedPhone,
            PartyB: SHORTCODE,
            PhoneNumber: formattedPhone,
            CallBackURL: CALLBACK_URL || 'https://example.com/callback',
            AccountReference: `John Munga`,
            TransactionDesc: 'Payment for services'
        };

        console.log('📤 Sending STK Push request...');
        console.log(`   Payload:`, JSON.stringify(payload, null, 2));

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

        console.log('✅ STK Push response:', response.data);

        res.json({
            success: true,
            message: 'STK Push sent successfully',
            data: response.data
        });

    } catch (error) {
        console.error('❌ STK Push error:');
        
        if (error.response) {
            console.error('   Status:', error.response.status);
            console.error('   Data:', JSON.stringify(error.response.data, null, 2));
        } else {
            console.error('   Error:', error.message);
        }
        
        res.status(500).json({
            success: false,
            message: 'Payment initiation failed',
            error: error.response?.data || error.message
        });
    }
});

// Callback endpoint
app.post('/api/callback', (req, res) => {
    console.log('📩 Callback received:', JSON.stringify(req.body, null, 2));
    
    try {
        const callback = req.body.Body.stkCallback;
        const resultCode = callback.ResultCode;
        const resultDesc = callback.ResultDesc;

        if (resultCode === 0) {
            const metadata = callback.CallbackMetadata.Item;
            const receipt = metadata.find(item => item.Name === 'MpesaReceiptNumber')?.Value;
            const amount = metadata.find(item => item.Name === 'Amount')?.Value;
            
            console.log(`✅ Payment successful: Receipt ${receipt}, Amount KES ${amount}`);
        } else {
            console.log(`❌ Payment failed: ${resultDesc} (Code: ${resultCode})`);
        }

        res.status(200).json({ ResultCode: 0, ResultDesc: 'Success' });
    } catch (error) {
        console.error('Callback processing error:', error);
        res.status(200).json({ ResultCode: 0, ResultDesc: 'Success' });
    }
});

const PORT = process.env.PORT || 3000;

// Start server after testing credentials
app.listen(PORT, async () => {
    console.log(`\n🚀 Server running on port ${PORT}`);
    console.log(`📍 http://localhost:${PORT}`);
    
    // Test credentials on startup
    await testCredentials();
});
