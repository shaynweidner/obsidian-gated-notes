import 'dotenv/config';
import fs from 'fs';
import path from 'path';

// Get the destination path from the .env file
const destination = process.env.PLUGIN_DEST_PATH;

if (!destination) {
  console.error('Error: PLUGIN_DEST_PATH is not defined in your .env file.');
  process.exit(1);
}

// Ensure the destination directory exists
fs.mkdirSync(destination, { recursive: true });

// Files to copy
const filesToCopy = ['main.js', 'manifest.json'];

for (const file of filesToCopy) {
  const sourcePath = path.join(process.cwd(), file);
  const destPath = path.join(destination, file);

  if (fs.existsSync(sourcePath)) {
    fs.copyFileSync(sourcePath, destPath);
    console.log(`Copied ${file} to vault.`);
  }
}
