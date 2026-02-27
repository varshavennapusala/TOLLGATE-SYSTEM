const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// PostgreSQL connection
const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
});

// Email configuration (COMPULSORY)
const emailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// API Routes

// User login - DEBUG VERSION
app.post('/api/login', async (req, res) => {
    const { userId, password } = req.body;

    console.log('🔐 Login attempt:', { userId, password });

    try {
        const result = await pool.query(
            'SELECT * FROM users WHERE user_id = $1 AND is_active = true',
            [userId]
        );

        console.log('📊 Database result:', result.rows.length ? 'User found' : 'User not found');

        if (result.rows.length === 0) {
            console.log('❌ User not found:', userId);
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }

        const user = result.rows[0];
        console.log('👤 User from DB:', { 
            user_id: user.user_id, 
            stored_password: user.password,
            entered_password: password 
        });

        // SIMPLE PASSWORD CHECK FOR DEMO
        if (password === user.password) {
            console.log('✅ Password matched!');
            
            await pool.query(
                'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE user_id = $1',
                [userId]
            );

            res.json({ 
                success: true, 
                message: 'Login successful',
                user: { 
                    userId: user.user_id, 
                    name: user.name,
                    tollBooth: user.toll_booth_number
                }
            });
        } else {
            console.log('❌ Password mismatch!');
            console.log('Expected:', user.password);
            console.log('Received:', password);
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }
    } catch (error) {
        console.error('💥 Login error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Get vehicle information
app.get('/api/vehicle/:vehicleNumber', async (req, res) => {
    const { vehicleNumber } = req.params;

    try {
        const result = await pool.query(
            `SELECT v.*, tr.amount as toll_amount 
             FROM vehicles v 
             LEFT JOIN toll_rates tr ON v.vehicle_type = tr.vehicle_type 
             WHERE v.vehicle_number = $1`,
            [vehicleNumber.toUpperCase()]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Vehicle not found' });
        }

        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('Vehicle info error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Process toll transaction (WITH COMPULSORY EMAIL)
app.post('/api/process-toll', async (req, res) => {
    const { vehicleNumber, paymentMethod, amount, userId, tollBooth } = req.body;

    try {
        // Generate receipt number
        const receiptNumber = 'RCPT' + Date.now();

        // Insert transaction
        const transactionResult = await pool.query(
            `INSERT INTO transactions (vehicle_number, payment_method, amount, user_id, toll_booth_number, receipt_number) 
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [vehicleNumber.toUpperCase(), paymentMethod, amount, userId, tollBooth, receiptNumber]
        );

        const transaction = transactionResult.rows[0];

        // Get vehicle info for notification
        const vehicleResult = await pool.query(
            'SELECT * FROM vehicles WHERE vehicle_number = $1',
            [vehicleNumber.toUpperCase()]
        );

        if (vehicleResult.rows.length > 0) {
            const vehicle = vehicleResult.rows[0];
            
            // COMPULSORY: Send email receipt
            const emailSent = await sendEmailReceipt(vehicle, transaction);

            if (!emailSent) {
                console.warn('Email failed but transaction completed');
            }
        } else {
            console.warn('Vehicle not found for email, but transaction completed');
        }

        res.json({ 
            success: true, 
            message: 'Toll processed successfully with email receipt',
            receiptNumber: receiptNumber,
            transaction: transaction
        });
    } catch (error) {
        console.error('Process toll error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Get reports
app.get('/api/reports', async (req, res) => {
    const { period } = req.query;

    try {
        let dateFilter = '';
        switch (period) {
            case 'today':
                dateFilter = "WHERE DATE(transaction_time) = CURRENT_DATE";
                break;
            case 'week':
                dateFilter = "WHERE transaction_time >= DATE_TRUNC('week', CURRENT_DATE)";
                break;
            case 'month':
                dateFilter = "WHERE transaction_time >= DATE_TRUNC('month', CURRENT_DATE)";
                break;
        }

        const summaryQuery = `
            SELECT 
                COUNT(*) as total_vehicles,
                COALESCE(SUM(CASE WHEN payment_method = 'cash' THEN amount ELSE 0 END), 0) as cash_amount,
                COALESCE(SUM(CASE WHEN payment_method = 'card' THEN amount ELSE 0 END), 0) as card_amount,
                COALESCE(SUM(CASE WHEN payment_method = 'online' THEN amount ELSE 0 END), 0) as online_amount,
                COALESCE(SUM(amount), 0) as total_amount
            FROM transactions 
            ${dateFilter}
        `;

        const summaryResult = await pool.query(summaryQuery);
        
        const transactionsQuery = `
            SELECT * FROM transactions 
            ${dateFilter}
            ORDER BY transaction_time DESC 
            LIMIT 100
        `;

        const transactionsResult = await pool.query(transactionsQuery);

        res.json({
            success: true,
            summary: summaryResult.rows[0],
            transactions: transactionsResult.rows
        });
    } catch (error) {
        console.error('Reports error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Search vehicle
app.get('/api/search-vehicle/:vehicleNumber', async (req, res) => {
    const { vehicleNumber } = req.params;

    try {
        const vehicleResult = await pool.query(
            'SELECT * FROM vehicles WHERE vehicle_number = $1',
            [vehicleNumber.toUpperCase()]
        );

        if (vehicleResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Vehicle not found' });
        }

        const transactionsResult = await pool.query(
            `SELECT t.*, u.name as operator_name 
             FROM transactions t 
             LEFT JOIN users u ON t.user_id = u.user_id 
             WHERE t.vehicle_number = $1 
             ORDER BY t.transaction_time DESC 
             LIMIT 10`,
            [vehicleNumber.toUpperCase()]
        );

        res.json({
            success: true,
            vehicle: vehicleResult.rows[0],
            transactions: transactionsResult.rows
        });
    } catch (error) {
        console.error('Search vehicle error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// COMPULSORY Email Function
async function sendEmailReceipt(vehicle, transaction) {
    try {
        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: vehicle.email,
            subject: `Toll Payment Receipt - ${transaction.receipt_number}`,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #4f46e5; text-align: center;">🚗 Toll Payment Receipt</h2>
                    <div style="background: #f8fafc; padding: 20px; border-radius: 10px;">
                        <p>Dear <strong>${vehicle.owner_name}</strong>,</p>
                        <p>Your toll payment has been processed successfully. Here are your transaction details:</p>
                        
                        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                            <tr style="background: #e2e8f0;">
                                <td style="padding: 10px; border: 1px solid #cbd5e0;"><strong>Receipt Number</strong></td>
                                <td style="padding: 10px; border: 1px solid #cbd5e0;">${transaction.receipt_number}</td>
                            </tr>
                            <tr>
                                <td style="padding: 10px; border: 1px solid #cbd5e0;"><strong>Vehicle Number</strong></td>
                                <td style="padding: 10px; border: 1px solid #cbd5e0;">${vehicle.vehicle_number}</td>
                            </tr>
                            <tr style="background: #e2e8f0;">
                                <td style="padding: 10px; border: 1px solid #cbd5e0;"><strong>Vehicle Type</strong></td>
                                <td style="padding: 10px; border: 1px solid #cbd5e0;">${vehicle.vehicle_type}</td>
                            </tr>
                            <tr>
                                <td style="padding: 10px; border: 1px solid #cbd5e0;"><strong>Payment Method</strong></td>
                                <td style="padding: 10px; border: 1px solid #cbd5e0;">${transaction.payment_method}</td>
                            </tr>
                            <tr style="background: #e2e8f0;">
                                <td style="padding: 10px; border: 1px solid #cbd5e0;"><strong>Amount Paid</strong></td>
                                <td style="padding: 10px; border: 1px solid #cbd5e0;">₹${transaction.amount}</td>
                            </tr>
                            <tr>
                                <td style="padding: 10px; border: 1px solid #cbd5e0;"><strong>Transaction Time</strong></td>
                                <td style="padding: 10px; border: 1px solid #cbd5e0;">${new Date(transaction.transaction_time).toLocaleString('en-IN')}</td>
                            </tr>
                            <tr style="background: #e2e8f0;">
                                <td style="padding: 10px; border: 1px solid #cbd5e0;"><strong>Toll Booth</strong></td>
                                <td style="padding: 10px; border: 1px solid #cbd5e0;">${transaction.toll_booth_number}</td>
                            </tr>
                        </table>
                        
                        <p style="text-align: center; color: #64748b; margin-top: 30px;">
                            Thank you for using our toll services!<br>
                            Safe travels! 🚗
                        </p>
                    </div>
                </div>
            `
        };

        await emailTransporter.sendMail(mailOptions);
        console.log('✅ Email sent successfully to:', vehicle.email);
        
        // Log email sent
        await pool.query(
            'INSERT INTO email_logs (vehicle_number, email, subject, message, status) VALUES ($1, $2, $3, $4, $5)',
            [vehicle.vehicle_number, vehicle.email, mailOptions.subject, 'Email sent successfully', 'sent']
        );
        
        return true;
    } catch (error) {
        console.error('❌ Email sending error:', error);
        await pool.query(
            'INSERT INTO email_logs (vehicle_number, email, subject, message, status) VALUES ($1, $2, $3, $4, $5)',
            [vehicle.vehicle_number, vehicle.email, 'Toll Payment Receipt', error.message, 'failed']
        );
        return false;
    }
}

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Default route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(port, () => {
    console.log(`🚗 Tollgate Management System running on http://localhost:${port}`);
    console.log(`📊 Database: ${process.env.DB_NAME}@${process.env.DB_HOST}`);
    console.log(`📧 Email: ${process.env.EMAIL_USER ? 'Configured' : 'Not configured'}`);
});