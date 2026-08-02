require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// Serve frontend
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

// Generate OAuth token
async function getAccessToken() {
    const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');
    
    try {
        const response = await axios.get(
            `${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
            {
                headers: {
                    Authorization: `Basic ${auth}`
                }
            }
        );
        return response.data.access_token;
    } catch (error) {
        console.error('Error generating token:', error.response?.data || error.message);
        throw error;
    }
}

// STK Push endpoint
app.post('/api/stk-push', async (req, res) => {
    try {
        const { phone, amount } = req.body;

        // Validate input
        if (!phone || !amount) {
            return res.status(400).json({
                success: false,
                message: 'Phone number and amount are required'
            });
        }

        // Format phone number to 254XXXXXXXXX
        let formattedPhone = phone.replace(/\s/g, '');
        if (formattedPhone.startsWith('0')) {
            formattedPhone = '254' + formattedPhone.slice(1);
        } else if (formattedPhone.startsWith('+')) {
            formattedPhone = formattedPhone.slice(1);
        }

        // Get access token
        const token = await getAccessToken();

        // Generate timestamp and password
        const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
        const password = Buffer.from(`${SHORTCODE}${PASSKEY}${timestamp}`).toString('base64');

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
            CallBackURL: CALLBACK_URL,
            AccountReference: `INV${Date.now()}`,
            TransactionDesc: 'Payment for services'
        };

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

        res.json({
            success: true,
            message: 'STK Push sent successfully',
            data: response.data
        });

    } catch (error) {
        console.error('STK Push error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            message: 'Payment initiation failed',
            error: error.response?.data || error.message
        });
    }
});

// Callback endpoint for M-Pesa
app.post('/api/callback', (req, res) => {
    console.log('📩 Callback received:', JSON.stringify(req.body, null, 2));
    
    try {
        const callback = req.body.Body.stkCallback;
        const resultCode = callback.ResultCode;
        const resultDesc = callback.ResultDesc;

        if (resultCode === 0) {
            // Payment successful
            const metadata = callback.CallbackMetadata.Item;
            const receipt = metadata.find(item => item.Name === 'MpesaReceiptNumber')?.Value;
            const amount = metadata.find(item => item.Name === 'Amount')?.Value;
            
            console.log(`✅ Payment successful: Receipt ${receipt}, Amount KES ${amount}`);
            // TODO: Update your database here
        } else {
            // Payment failed
            console.log(`❌ Payment failed: ${resultDesc} (Code: ${resultCode})`);
        }

        // Always respond with 200 to acknowledge receipt
        res.status(200).json({ ResultCode: 0, ResultDesc: 'Success' });
    } catch (error) {
        console.error('Callback processing error:', error);
        res.status(200).json({ ResultCode: 0, ResultDesc: 'Success' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
