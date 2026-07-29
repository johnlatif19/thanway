const express = require('express');
const admin = require('firebase-admin');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const XLSX = require('xlsx');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const path = require('path');
const { v2: cloudinary } = require('cloudinary');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== MIDDLEWARE ====================
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cookieParser());

app.use(cors({
  origin: '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cookie', 'Accept']
}));

app.use(express.static('public'));

// ==================== FIREBASE ADMIN (للـ Firestore فقط) ====================
let db;
try {
  const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
  admin.initializeApp({
    credential: admin.credential.cert(firebaseConfig)
  });
  db = admin.firestore();
  console.log('✅ Firebase Firestore initialized');
} catch (error) {
  console.error('❌ Firebase error:', error);
}

// ==================== CLOUDINARY ====================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});
console.log('✅ Cloudinary initialized');

// ==================== MULTER ====================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { 
    fileSize: 100 * 1024 * 1024 // 100MB
  }
});

// ==================== JWT MIDDLEWARE ====================
const verifyJWT = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1] || req.query.token || req.cookies?.token;
  
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
    const token = req.headers.authorization?.split(' ')[1] || req.cookies?.token;
    
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

// ==================== READ CSV ====================
function parseCSV(buffer) {
  const results = [];
  const csvContent = buffer.toString('utf-8');
  
  const lines = csvContent.split('\n').filter(line => line.trim());
  if (lines.length === 0) return results;
  
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    const values = [];
    let currentValue = '';
    let insideQuotes = false;
    
    for (let j = 0; j < line.length; j++) {
      const char = line[j];
      if (char === '"') {
        insideQuotes = !insideQuotes;
      } else if (char === ',' && !insideQuotes) {
        values.push(currentValue.trim());
        currentValue = '';
      } else {
        currentValue += char;
      }
    }
    values.push(currentValue.trim());
    
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] || '';
    });
    results.push(row);
  }
  
  return results;
}

// ==================== UPLOAD TO CLOUDINARY ====================
app.post('/api/upload-to-cloudinary', verifyJWT, upload.single('file'), async (req, res) => {
  console.log('📤 Upload to Cloudinary');
  
  try {
    if (!req.file) {
      console.log('❌ No file received');
      return res.status(400).json({ error: 'No file uploaded' });
    }

    console.log('📊 File size:', req.file.size, 'bytes');
    console.log('📊 File name:', req.file.originalname);
    console.log('📊 File type:', req.file.mimetype);

    // Upload to Cloudinary
    const result = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: 'student_results',
          resource_type: 'auto',
          public_id: `${Date.now()}_${req.file.originalname.split('.')[0]}`,
          use_filename: true,
          unique_filename: true
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      
      // Convert buffer to stream
      const Readable = require('stream').Readable;
      const stream = new Readable();
      stream.push(req.file.buffer);
      stream.push(null);
      stream.pipe(uploadStream);
    });

    console.log('✅ File uploaded to Cloudinary');
    console.log('🔗 Public URL:', result.secure_url);

    // Now process the file data
    let data = [];
    const fileNameLower = req.file.originalname.toLowerCase();
    const fileBuffer = req.file.buffer;

    // Parse file based on type
    if (fileNameLower.endsWith('.csv') || req.file.mimetype === 'text/csv' || req.file.mimetype === 'application/csv') {
      try {
        data = parseCSV(fileBuffer);
        console.log(`📊 Parsed ${data.length} rows from CSV`);
      } catch (error) {
        console.error('❌ Error parsing CSV:', error);
        return res.status(400).json({ error: 'Invalid CSV file format' });
      }
    } else {
      try {
        const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
        if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
          return res.status(400).json({ error: 'File has no sheets' });
        }
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        data = XLSX.utils.sheet_to_json(worksheet);
        console.log(`📊 Parsed ${data.length} rows from Excel`);
      } catch (error) {
        console.error('❌ Error reading file:', error);
        return res.status(400).json({ error: 'Invalid file format' });
      }
    }

    if (!data || data.length === 0) {
      return res.status(400).json({ error: 'File is empty or invalid' });
    }

    if (!db) {
      console.error('❌ Firestore not initialized');
      return res.status(500).json({ error: 'Database not initialized' });
    }

    // Process and save to Firestore
    let processedCount = 0;
    let batch = db.batch();
    let batchCount = 0;

    for (const row of data) {
      const seatNumber = String(
        row['seat_number'] || 
        row['رقم الجلوس'] || 
        row['Seat Number'] || 
        row['SeatNumber'] || 
        row['Seat_Number'] ||
        ''
      );
      
      if (!seatNumber) continue;

      const docRef = db.collection('results').doc(seatNumber);
      
      const studentData = {
        seat_number: seatNumber,
        student_name: String(row['student_name'] || row['اسم الطالب'] || row['Student Name'] || row['StudentName'] || row['Student_Name'] || ''),
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
      count: processedCount,
      fileUrl: result.secure_url,
      fileName: result.public_id
    });

  } catch (error) {
    console.error('❌ Upload error:', error);
    return res.status(500).json({ 
      error: 'Failed to process file: ' + error.message 
    });
  }
});

// ==================== SEARCH ====================
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

// ==================== COUNT ====================
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
