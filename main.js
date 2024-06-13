#!/usr/bin/env node
const SwaggerParser = require('swagger-parser');
const { Command } = require('commander');
const fs = require('fs-extra');
const path = require('path');
const pjson = require('./package.json');


const program = new Command();

program.version(`v${pjson.version}`, '-v, --version');
program
    .option('-i, --input <inputFilePath>', 'Path to the input Swagger file')
    .option('-o, --output <outputFilePath>', 'Path to the output directory')
    .option('-c, --config <configMapping>', 'Path to the JSON file containing map of' +
        ' operationId to prefix and suffix');

program.parse(process.argv);
const options = program.opts();


const writeJsonToFile = async (filePath, data) => {
    await fs.ensureDir(path.dirname(filePath));
    await fs.writeJson(filePath, data, { spaces: 2 });
};
function updateMainObjDefinition(mainObj, refPath, refName, newRefName, prefix = '', suffix = '') {
    if (mainObj && mainObj[refPath] && mainObj[refPath][refName]) {
        if (refName !== newRefName) {
            Object.defineProperty(mainObj[refPath], newRefName,
                Object.getOwnPropertyDescriptor(mainObj[refPath], refName));
            delete mainObj[refPath][refName];
        }
        if (typeof mainObj[refPath][newRefName] === 'object') {
            addPrefixSuffixToRefs(mainObj, mainObj[refPath][newRefName], prefix, suffix)
        }
    }
}
function addPrefixSuffixToRefs(mainObj, currentObj, prefix = '', suffix = '') {
    for (const key in currentObj) {
        if (key === '$ref') {
            const refArr = currentObj[key].split('/')
            const refPath = refArr[1]
            const refName = refArr[2]
            const newRefName = `${prefix}${refName}${suffix}`
            currentObj[key] = `#/${refPath}/${newRefName}`
            updateMainObjDefinition(mainObj, refPath, refName, newRefName, prefix, suffix)
        } else if (typeof currentObj[key] === 'object') {
            addPrefixSuffixToRefs(mainObj, currentObj[key], prefix, suffix)
        }
    }
    return mainObj;
}

// Load and parse the Swagger file
async function modifySwaggerFile(inputFilePath, outputFilePath, configMapping) {
    try {
        const api = await SwaggerParser.bundle(inputFilePath)
        for (const apiPath in api.paths) {
            for (const method in api.paths[apiPath]) {
                const { prefix = '', suffix = '', inputSuffix = '' } =
                    (configMapping[apiPath] && configMapping[apiPath][method]) ? configMapping[apiPath][method] : {}
                addPrefixSuffixToRefs(api, api.paths[apiPath][method].parameters, prefix, suffix + inputSuffix)
                addPrefixSuffixToRefs(api, api.paths[apiPath][method].responses, prefix, suffix)
            }
        }
        writeJsonToFile(outputFilePath, api)
    } catch (err) {
        console.error(err);
    }
}


if (!options.input || !options.output || !options.config) {
    console.error('Error: Input file path, output directory, and operation mapping file are required.');
    process.exit(1);
}


fs.readJson(options.config)
    .then(async configMapping => {
        await modifySwaggerFile(options.input, options.output, configMapping);
    })
    .catch(err => {
        console.error('Error reading operation mapping file:', err);
    });

modules.exports = { modifySwaggerFile }
