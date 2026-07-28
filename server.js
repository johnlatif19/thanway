const express = require('express');
const admin = require('firebase-admin');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const XLSX = require('xlsx');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== MIDDLEWARE ====================
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(cookieParser());

// CORS - Allow all
app.use(cors({
  origin: '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cookie', 'Accept']
}));

app.use(express.static('public'));

// ==================== FIREBASE ====================
let db;
try {
  const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
  admin.initializeApp({
    credential: admin.credential.cert(firebaseConfig)
  });
  db = admin.firestore();
  console.log('✅ Firebase initialized');
} catch (error) {
  console.error('❌ Firebase error:', error);
}

// ==================== MULTER ====================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { 
    fileSize: 100 * 1024 * 1024 // 100MB limit
  }
});

// ==================== JWT MIDDLEWARE ====================
const verifyJWT = (req, res, next) => {
  // Try multiple sources for token
  const token = req.cookies?.token || 
                req.headers.authorization?.split(' ')[1] ||
                req.query.token;
  
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized - No token' });
  }
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'mysecretkey');
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// ==================== HTML ROUTES ====================
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/dashboard', (req, res) => {
  const token = req.query.token || req.cookies?.token;
  
  if (token) {
    try {
      jwt.verify(token, process.env.JWT_SECRET || 'mysecretkey');
      return res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
    } catch (error) {
      console.log('Invalid token for dashboard');
    }
  }
  
  res.redirect('/login');
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== API ROUTES ====================

// Test endpoint
app.get('/api/test', (req, res) => {
  res.json({ status: 'Server is working!' });
});

// Login endpoint
app.post('/api/login', async (req, res) => {
  console.log('📤 Login attempt:', req.body.username);
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    
    const adminUsername = process.env.ADMIN_USERNAME || 'admin';
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
    
    if (username === adminUsername && password === adminPassword) {
      const token = jwt.sign(
        { username, role: 'admin' },
        process.env.JWT_SECRET || 'mysecretkey',
        { expiresIn: '24h' }
      );
      
      res.cookie('token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000
      });
      
      return res.json({ 
        success: true, 
        message: 'Login successful',
        token: token,
        username: username
      });
    } else {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
  } catch (error) {
    console.error('❌ Login error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Check authentication
app.get('/api/check-auth', (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1] || 
                  req.cookies?.token || 
                  req.query.token;
    
    if (!token) {
      return res.json({ authenticated: false });
    }
    
    jwt.verify(token, process.env.JWT_SECRET || 'mysecretkey');
    return res.json({ authenticated: true });
  } catch (error) {
    return res.json({ authenticated: false });
  }
});

// Logout
app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true, message: 'Logged out successfully' });
});

// Upload Excel file - IMPROVED
app.post('/api/upload', verifyJWT, upload.single('file'), async (req, res) => {
  console.log('📤 Upload attempt');
  console.log('📄 File:', req.file);
  
  try {
    if (!req.file) {
      console.log('❌ No file received');
      return res.status(400).json({ error: 'No file uploaded' });
    }

    console.log('📊 File size:', req.file.size, 'bytes');
    console.log('📊 File name:', req.file.originalname);

    // Try to read the file
    let workbook;
    try {
      workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    } catch (error) {
      console.error('❌ Error reading Excel:', error);
      return res.status(400).json({ error: 'Invalid Excel file format' });
    }

    if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
      return res.status(400).json({ error: 'Excel file has no sheets' });
    }

    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet);

    if (!data || data.length === 0) {
      return res.status(400).json({ error: 'File is empty or invalid' });
    }

    console.log(`📊 Processing ${data.length} rows`);

    // Check if db is initialized
    if (!db) {
      console.error('❌ Firebase not initialized');
      return res.status(500).json({ error: 'Database not initialized' });
    }

    let processedCount = 0;
    let batch = db.batch();
    let batchCount = 0;

    for (const row of data) {
      // Try different field names for seat number
      const seatNumber = String(
        row['seat_number'] || 
        row['رقم الجلوس'] || 
        row['Seat Number'] || 
        row['SeatNumber'] || 
        ''
      );
      
      if (!seatNumber) {
        console.log('⚠️ Skipping row without seat number:', row);
        continue;
      }

      const docRef = db.collection('results').doc(seatNumber);
      
      const studentData = {
        seat_number: seatNumber,
        student_name: String(row['student_name'] || row['اسم الطالب'] || row['Student Name'] || row['StudentName'] || ''),
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
      batchCount++;
      
      if (batchCount >= 500) {
        await batch.commit();
        batch = db.batch();
        batchCount = 0;
        console.log(`📊 Committed ${processedCount} records`);
      }
    }

    if (batchCount > 0) {
      await batch.commit();
    }

    console.log(`✅ Successfully processed ${processedCount} students`);

    return res.json({ 
      success: true, 
      message: `Successfully processed ${processedCount} students`,
      count: processedCount
    });

  } catch (error) {
    console.error('❌ Upload error:', error);
    console.error('❌ Error stack:', error.stack);
    return res.status(500).json({ 
      error: 'Failed to process file: ' + error.message 
    });
  }
});

// Search endpoint
app.get('/api/search', async (req, res) => {
  try {
    const q = req.query.q || '';
    
    if (!q.trim()) {
      return res.json([]);
    }

    const isNumeric = /^\d+$/.test(q.trim());
    let results = [];
    
    if (isNumeric) {
      const docRef = db.collection('results').doc(q.trim());
      const doc = await docRef.get();
      
      if (doc.exists) {
        results = [doc.data()];
      }
    } else {
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
    console.error('❌ Search error:', error);
    return res.status(500).json({ error: 'Search failed' });
  }
});

// Get total count
app.get('/api/count', verifyJWT, async (req, res) => {
  try {
    const snapshot = await db.collection('results').get();
    return res.json({ count: snapshot.size });
  } catch (error) {
    console.error('❌ Count error:', error);
    return res.status(500).json({ error: 'Failed to get count' });
  }
});

// ==================== CATCH-ALL ====================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== START ====================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
