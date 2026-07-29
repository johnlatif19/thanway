/**
 * import-firebase.js
 * ملف منفصل لرفع الملفات مباشرة إلى Firebase Storage
 * يمكن استخدامه مع Node.js أو مع المتصفح
 */

const admin = require('firebase-admin');
const { Storage } = require('@google-cloud/storage');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// ==================== FIREBASE ADMIN ====================
let db;
let bucket;
let storage;

try {
  const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
  
  // Initialize Firebase Admin
  admin.initializeApp({
    credential: admin.credential.cert(firebaseConfig),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 'your-project-id.appspot.com'
  });
  
  db = admin.firestore();
  
  // Initialize Google Cloud Storage
  storage = new Storage({
    projectId: firebaseConfig.project_id,
    credentials: firebaseConfig
  });
  
  bucket = storage.bucket(process.env.FIREBASE_STORAGE_BUCKET || 'your-project-id.appspot.com');
  
  console.log('✅ Firebase initialized');
  console.log('✅ Firebase Storage initialized');
  console.log('✅ Firestore initialized');
} catch (error) {
  console.error('❌ Firebase error:', error);
  process.exit(1);
}

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

// ==================== UPLOAD FILE TO FIREBASE ====================
async function uploadFileToFirebase(filePath, customFileName = null) {
  try {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const fileBuffer = fs.readFileSync(filePath);
    const originalName = path.basename(filePath);
    const timestamp = Date.now();
    const fileName = customFileName || `uploads/${timestamp}_${originalName}`;
    
    console.log(`📤 Uploading: ${originalName}`);
    console.log(`📊 File size: ${(fileBuffer.length / 1024 / 1024).toFixed(2)} MB`);

    const file = bucket.file(fileName);

    // Upload file to Firebase Storage
    await file.save(fileBuffer, {
      metadata: {
        contentType: getContentType(filePath),
        metadata: {
          uploadedBy: 'import-firebase-script',
          uploadedAt: new Date().toISOString(),
          originalName: originalName
        }
      }
    });

    // Make file public
    await file.makePublic();
    
    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
    
    console.log(`✅ File uploaded successfully`);
    console.log(`🔗 Public URL: ${publicUrl}`);

    return {
      success: true,
      fileName: fileName,
      publicUrl: publicUrl,
      size: fileBuffer.length
    };

  } catch (error) {
    console.error(`❌ Upload error:`, error);
    return {
      success: false,
      error: error.message
    };
  }
}

// ==================== UPLOAD AND PROCESS FILE ====================
async function uploadAndProcessFile(filePath, collectionName = 'results') {
  try {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const fileBuffer = fs.readFileSync(filePath);
    const originalName = path.basename(filePath);
    const timestamp = Date.now();
    const fileName = `uploads/${timestamp}_${originalName}`;
    
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
        const XLSX = require('xlsx');
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

    // Upload file to Firebase Storage
    const file = bucket.file(fileName);
    await file.save(fileBuffer, {
      metadata: {
        contentType: getContentType(filePath),
        metadata: {
          uploadedBy: 'import-firebase-script',
          uploadedAt: new Date().toISOString(),
          originalName: originalName,
          recordCount: data.length.toString()
        }
      }
    });

    await file.makePublic();
    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
    console.log(`✅ File uploaded to Storage`);

    // Save to Firestore
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
      fileName: fileName,
      publicUrl: publicUrl,
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

// ==================== GET CONTENT TYPE ====================
function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.csv': 'text/csv',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xls': 'application/vnd.ms-excel',
    '.txt': 'text/plain',
    '.json': 'application/json',
    '.pdf': 'application/pdf'
  };
  return types[ext] || 'application/octet-stream';
}

// ==================== LIST ALL FILES ====================
async function listFiles(prefix = 'uploads/') {
  try {
    const [files] = await bucket.getFiles({ prefix: prefix });
    
    const fileList = files.map(file => ({
      name: file.name,
      size: file.metadata.size,
      contentType: file.metadata.contentType,
      created: file.metadata.timeCreated,
      publicUrl: `https://storage.googleapis.com/${bucket.name}/${file.name}`
    }));
    
    console.log(`📁 Found ${fileList.length} files`);
    return fileList;
  } catch (error) {
    console.error('❌ Error listing files:', error);
    return [];
  }
}

// ==================== DELETE FILE ====================
async function deleteFile(fileName) {
  try {
    const file = bucket.file(fileName);
    await file.delete();
    console.log(`✅ Deleted: ${fileName}`);
    return { success: true, message: `Deleted: ${fileName}` };
  } catch (error) {
    console.error(`❌ Error deleting file:`, error);
    return { success: false, error: error.message };
  }
}

// ==================== COMMAND LINE INTERFACE ====================
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];
  const filePath = args[1];

  console.log('🚀 Firebase Import Tool');
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
          console.log(`🔗 URL: ${result.publicUrl}`);
        } else {
          console.log('\n❌ Import failed:', result.error);
        }
      });
      break;

    case 'list':
      listFiles().then(files => {
        console.log('\n📁 Uploaded Files:');
        files.forEach(f => {
          console.log(`  - ${f.name} (${(f.size / 1024).toFixed(1)} KB)`);
        });
      });
      break;

    case 'delete':
      if (!filePath) {
        console.error('❌ Please provide file name to delete');
        console.log('Usage: node import-firebase.js delete <file-name>');
        process.exit(1);
      }
      deleteFile(filePath).then(result => {
        if (result.success) {
          console.log('✅ File deleted successfully');
        } else {
          console.log('❌ Delete failed:', result.error);
        }
      });
      break;

    default:
      console.log('📖 Usage:');
      console.log('  node import-firebase.js upload <file-path>    - Upload and process file');
      console.log('  node import-firebase.js list                  - List all uploaded files');
      console.log('  node import-firebase.js delete <file-name>    - Delete a file');
      console.log('\nExamples:');
      console.log('  node import-firebase.js upload ./data.csv');
      console.log('  node import-firebase.js upload ./students.xlsx');
      console.log('  node import-firebase.js list');
      console.log('  node import-firebase.js delete uploads/123456789_data.csv');
  }
}

// ==================== EXPORTS ====================
module.exports = {
  uploadFileToFirebase,
  uploadAndProcessFile,
  listFiles,
  deleteFile,
  parseCSV,
  db,
  bucket,
  storage
};import-firebase.js
