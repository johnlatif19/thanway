/**
 * import-firebase.js
 * ملف لرفع الملفات مباشرة إلى Cloudinary ومعالجتها
 * يمكن استخدامه مع Node.js كأداة سطر أوامر
 */

const admin = require('firebase-admin');
const { v2: cloudinary } = require('cloudinary');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
require('dotenv').config();

// ==================== FIREBASE ADMIN (لـ Firestore فقط) ====================
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
  process.exit(1);
}

// ==================== CLOUDINARY ====================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

console.log('✅ Cloudinary initialized');

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

// ==================== UPLOAD AND PROCESS FILE ====================
async function uploadAndProcessFile(filePath, collectionName = 'results') {
  try {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const fileBuffer = fs.readFileSync(filePath);
    const originalName = path.basename(filePath);
    
    console.log(`📤 Processing: ${originalName}`);
    console.log(`📊 File size: ${(fileBuffer.length / 1024 / 1024).toFixed(2)} MB`);

    // Parse file data
    let data = [];
    const fileNameLower = originalName.toLowerCase();

    if (fileNameLower.endsWith('.csv')) {
      try {
        data = parseCSV(fileBuffer);
        console.log(`📊 Parsed ${data.length} rows from CSV`);
      } catch (error) {
        console.error('❌ Error parsing CSV:', error);
        throw new Error('Invalid CSV file format');
      }
    } else if (fileNameLower.endsWith('.xlsx') || fileNameLower.endsWith('.xls')) {
      try {
        const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
        if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
          throw new Error('File has no sheets');
        }
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        data = XLSX.utils.sheet_to_json(worksheet);
        console.log(`📊 Parsed ${data.length} rows from Excel`);
      } catch (error) {
        console.error('❌ Error reading file:', error);
        throw new Error('Invalid file format');
      }
    } else {
      throw new Error('Unsupported file format. Please use .csv, .xlsx, or .xls');
    }

    if (!data || data.length === 0) {
      throw new Error('File is empty or invalid');
    }

    // ============ UPLOAD TO CLOUDINARY ============
    console.log('📤 Uploading to Cloudinary...');
    
    const uploadResult = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: 'student_results',
          resource_type: 'auto',
          public_id: `${Date.now()}_${originalName.split('.')[0]}`,
          use_filename: true,
          unique_filename: true
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      
      const Readable = require('stream').Readable;
      const stream = new Readable();
      stream.push(fileBuffer);
      stream.push(null);
      stream.pipe(uploadStream);
    });

    console.log('✅ File uploaded to Cloudinary');
    console.log('🔗 Public URL:', uploadResult.secure_url);

    // ============ SAVE TO FIRESTORE ============
    console.log('📤 Saving to Firestore...');

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

      const docRef = db.collection(collectionName).doc(seatNumber);
      
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

    return {
      success: true,
      fileName: originalName,
      publicUrl: uploadResult.secure_url,
      cloudinaryPublicId: uploadResult.public_id,
      recordCount: processedCount,
      fileSize: fileBuffer.length
    };

  } catch (error) {
    console.error(`❌ Error:`, error);
    return {
      success: false,
      error: error.message
    };
  }
}

// ==================== COMMAND LINE INTERFACE ====================
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];
  const filePath = args[1];

  console.log('🚀 Cloudinary Import Tool');
  console.log('=======================');

  switch (command) {
    case 'upload':
      if (!filePath) {
        console.error('❌ Please provide file path');
        console.log('Usage: node import-firebase.js upload <file-path>');
        process.exit(1);
      }
      uploadAndProcessFile(filePath).then(result => {
        if (result.success) {
          console.log('\n✅ Import completed successfully!');
          console.log(`📊 Records: ${result.recordCount}`);
          console.log(`🔗 Cloudinary URL: ${result.publicUrl}`);
        } else {
          console.log('\n❌ Import failed:', result.error);
        }
      });
      break;

    default:
      console.log('📖 Usage:');
      console.log('  node import-firebase.js upload <file-path>    - Upload and process file');
      console.log('\nExamples:');
      console.log('  node import-firebase.js upload ./data.csv');
      console.log('  node import-firebase.js upload ./students.xlsx');
  }
}

// ==================== EXPORTS ====================
module.exports = {
  uploadAndProcessFile,
  parseCSV,
  db
};
