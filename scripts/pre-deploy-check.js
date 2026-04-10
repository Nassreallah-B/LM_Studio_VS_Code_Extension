const { execSync } = require('child_process');

console.log('Running pre-deploy syntax checks...');

const filesToCheck = [
  'extension.js',
  'lib/runtimeFeatures.js'
];

let hasErrors = false;

for (const file of filesToCheck) {
  try {
    execSync(`node -c ${file}`, { stdio: 'pipe' });
    console.log(`✅ Syntax OK: ${file}`);
  } catch (error) {
    console.error(`❌ Syntax Error in ${file}:`);
    console.error(error.message);
    hasErrors = true;
  }
}

if (hasErrors) {
  console.error('\nPre-deploy check failed! Please fix the errors above before deploying.');
  process.exit(1);
} else {
  console.log('\nAll syntax checks passed. Safe to deploy.');
}
