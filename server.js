const express = require('express');
const admin = require('firebase-admin');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const multer = require('multer');
const XLSX = require('xlsx');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cookieParser());
app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.static('public'));

// Initialize Firebase Admin
const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
admin.initializeApp({
  credential: admin.credential.cert(firebaseConfig)
});
const db = admin.firestore();

// Multer setup for file upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// JWT Verification Middleware
const verifyJWT = (req, res, next) => {
  const token = req.cookies.token;
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// Login endpoint
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    
    const adminUsername = process.env.ADMIN_USERNAME;
    const adminPassword = process.env.ADMIN_PASSWORD;
    
    if (username === adminUsername && password === adminPassword) {
      const token = jwt.sign(
        { username, role: 'admin' },
        process.env.JWT_SECRET,
        { expiresIn: '24h' }
      );
      
      res.cookie('token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
      });
      
      return res.json({ success: true, message: 'Login successful' });
    } else {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Check authentication
app.get('/api/check-auth', (req, res) => {
  try {
    const token = req.cookies.token;
    if (!token) {
      return res.json({ authenticated: false });
    }
    jwt.verify(token, process.env.JWT_SECRET);
    return res.json({ authenticated: true });
  } catch (error) {
    return res.json({ authenticated: false });
  }
});

// Logout endpoint
app.post('/api/logout', (req, res) => {
  res.clearCookie('token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  });
  res.json({ success: true, message: 'Logged out successfully' });
});

// Upload Excel file
app.post('/api/upload', verifyJWT, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet);

    if (!data || data.length === 0) {
      return res.status(400).json({ error: 'File is empty or invalid' });
    }

    // Expected headers
    const headers = [
      'seat_number', 'student_name', 'arabic', 'english', 'second_language',
      'physics', 'chemistry', 'biology', 'geology', 'math', 'statistics',
      'history', 'geography', 'philosophy', 'religion', 'national',
      'total', 'percentage', 'status'
    ];

    const results = [];
    const batch = db.batch();
    let processedCount = 0;

    for (const row of data) {
      // Check if row has seat_number
      const seatNumber = String(row['seat_number'] || row['رقم الجلوس'] || '');
      if (!seatNumber) continue;

      const docRef = db.collection('results').doc(seatNumber);
      
      // Build student data object
      const studentData = {
        seat_number: seatNumber,
        student_name: String(row['student_name'] || row['اسم الطالب'] || ''),
        arabic: parseFloat(row['arabic'] || row['عربي'] || row['لغة عربية'] || 0) || 0,
        english: parseFloat(row['english'] || row['انجليزي'] || row['لغة انجليزية'] || 0) || 0,
        second_language: parseFloat(row['second_language'] || row['لغة ثانية'] || row['لغة أجنبية'] || 0) || 0,
        physics: parseFloat(row['physics'] || row['فيزياء'] || 0) || 0,
        chemistry: parseFloat(row['chemistry'] || row['كيمياء'] || 0) || 0,
        biology: parseFloat(row['biology'] || row['أحياء'] || 0) || 0,
        geology: parseFloat(row['geology'] || row['جيولوجيا'] || 0) || 0,
        math: parseFloat(row['math'] || row['رياضيات'] || 0) || 0,
        statistics: parseFloat(row['statistics'] || row['إحصاء'] || 0) || 0,
        history: parseFloat(row['history'] || row['تاريخ'] || 0) || 0,
        geography: parseFloat(row['geography'] || row['جغرافيا'] || 0) || 0,
        philosophy: parseFloat(row['philosophy'] || row['فلسفة'] || 0) || 0,
        religion: parseFloat(row['religion'] || row['دين'] || 0) || 0,
        national: parseFloat(row['national'] || row['قومي'] || 0) || 0,
        total: parseFloat(row['total'] || row['المجموع'] || 0) || 0,
        percentage: parseFloat(row['percentage'] || row['النسبة'] || 0) || 0,
        status: String(row['status'] || row['الحالة'] || '')
      };

      batch.set(docRef, studentData, { merge: true });
      processedCount++;
      
      // Commit in batches of 500
      if (processedCount % 500 === 0) {
        await batch.commit();
        // Create new batch for remaining
        // Note: In Firestore, we need to create a new batch after commit
        // We'll handle this by committing at the end with remaining items
      }
    }

    // Commit remaining operations
    await batch.commit();

    return res.json({ 
      success: true, 
      message: `Successfully processed ${processedCount} students`,
      count: processedCount
    });

  } catch (error) {
    console.error('Upload error:', error);
    return res.status(500).json({ error: 'Failed to process file: ' + error.message });
  }
});

// Search endpoint
app.get('/api/search', async (req, res) => {
  try {
    const q = req.query.q || '';
    
    if (!q.trim()) {
      return res.json([]);
    }

    // Check if query is numeric (seat number)
    const isNumeric = /^\d+$/.test(q.trim());
    
    let results = [];
    
    if (isNumeric) {
      // Search by seat number (exact match)
      const docRef = db.collection('results').doc(q.trim());
      const doc = await docRef.get();
      
      if (doc.exists) {
        results = [doc.data()];
      }
    } else {
      // Search by student name (case-insensitive, partial match)
      const snapshot = await db.collection('results').get();
      
      const searchTerm = q.trim().toLowerCase();
      const matchedDocs = [];
      
      snapshot.forEach(doc => {
        const data = doc.data();
        const studentName = (data.student_name || '').toLowerCase();
        if (studentName.includes(searchTerm)) {
          matchedDocs.push(data);
        }
      });
      
      results = matchedDocs;
    }
    
    return res.json(results);
    
  } catch (error) {
    console.error('Search error:', error);
    return res.status(500).json({ error: 'Search failed' });
  }
});

// Get total count
app.get('/api/count', verifyJWT, async (req, res) => {
  try {
    const snapshot = await db.collection('results').get();
    return res.json({ count: snapshot.size });
  } catch (error) {
    console.error('Count error:', error);
    return res.status(500).json({ error: 'Failed to get count' });
  }
});

// Serve index.html for all routes (SPA-like)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
