const { INodeType, INodeTypeDescription } = require('n8n-workflow');
const pdfParse = require('pdf-parse');
const XLSX = require('xlsx');

class FileDataExtractor {
    description = {
        displayName: 'File Data Extractor',
        name: 'fileDataExtractor',
        icon: 'fa:file',
        group: ['transform'],
        version: 1,
        description: 'Extracts text and data from PDF or Excel files passed from previous nodes (e.g. Download node)',
        defaults: {
            name: 'File Data Extractor',
        },
        inputs: ['main'],
        outputs: ['main'],
        properties: [],
    };

    async execute() {
        const items = this.getInputData();
        const results = [];

        for (let i = 0; i < items.length; i++) {
            const binaryKeys = Object.keys(items[i].binary || {});
            if (binaryKeys.length === 0) {
                results.push({
                    json: { error: 'No file found in input binary data' },
                });
                continue;
            }

            const fileKey = binaryKeys[0];
            const binaryData = items[i].binary[fileKey];
            const fileName = binaryData.fileName || 'unnamed_file';
            const fileExt = (fileName.split('.').pop() || '').toLowerCase();
            const fileBuffer = Buffer.from(binaryData.data, 'base64');

            let extractedText = '';

            try {
                if (fileExt === 'pdf') {
                    // Extract text from PDF
                    const pdfData = await pdfParse(fileBuffer);
                    extractedText = `📄 FILE: ${fileName}\n\n${pdfData.text}`;
                } else if (['xlsx', 'xls'].includes(fileExt)) {
                    // Extract text from Excel
                    const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
                    extractedText = `📊 FILE: ${fileName}\n`;

                    workbook.SheetNames.forEach((sheetName) => {
                        const sheetData = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]);
                        extractedText += `\n-----------------------------\nSHEET: ${sheetName}\n-----------------------------\n${sheetData}\n`;
                    });
                } else {
                    extractedText = `⚠️ Unsupported file type: ${fileExt}`;
                }

                results.push({
                    json: {
                        file: fileName,
                        extracted_text: extractedText,
                    },
                });

            } catch (error) {
                results.push({
                    json: {
                        file: fileName,
                        error: error.message,
                    },
                });
            }
        }

        return this.prepareOutputData(results);
    }
}

module.exports = { nodeClass: FileDataExtractor };
