#!/usr/bin/env node

const SwaggerParser = require('swagger-parser');
const { Command } = require('commander');
const fs = require('fs-extra');
const path = require('path');
const pjson = require('./package.json');

const program = new Command();

program
    .version(`v${pjson.version}`, '-v, --version')
    .option('-i, --input <inputFilePath>', 'Path to the input Swagger file')
    .option('-o, --output <outputFilePath>', 'Path to the output directory')
    .option('-c, --config <configMapping>', 'Path to the JSON file containing mapping of operationId to prefix and suffix')
    .option('-oc, --open-api-config-output-path <openApiConfigOutputPath>', 'Path to the output OpenAPI config file')
    .parse(process.argv);

const options = program.opts();

const camelize = (str) => str.toLowerCase().replace(/[^a-zA-Z0-9]+(.)/g, (m, chr) => chr.toUpperCase());

const writeJsonToFile = async (filePath, data) => {
    await fs.ensureDir(path.dirname(filePath));
    await fs.writeJson(filePath, data, { spaces: 2 });
};

const updateMainObjDefinition = (mainObj, refPath, refName, newRefName, prefix = '', suffix = '', refs = [], inputSuffix = '') => {
    if (mainObj?.[refPath]?.[refName]) {
        if (refName !== newRefName) {
            Object.defineProperty(mainObj[refPath], newRefName, Object.getOwnPropertyDescriptor(mainObj[refPath], refName));
            delete mainObj[refPath][refName];
        }
        if (typeof mainObj[refPath][newRefName] === 'object') {
            addPrefixSuffixToRefs(mainObj, mainObj[refPath][newRefName], prefix, suffix, refs, inputSuffix);
        }
    }
};

const addPrefixSuffixToRefs = (mainObj, currentObj, prefix = '', suffix = '', refs = [], inputSuffix = '') => {
    for (const key in currentObj) {
        if (key === '$ref') {
            const [_, refPath, refName] = currentObj[key].split('/');
            if (refName.startsWith(prefix) && (refName.endsWith(suffix) || refName.endsWith(inputSuffix))) {
                continue;
            }
            let newRefName = `${prefix}${refName}${suffix}`;
            currentObj[key] = `#/${refPath}/${newRefName}`;
            if (!refs.includes(currentObj[key])) {
                currentObj[key] = `#/${refPath}/${newRefName}${inputSuffix}`;
                newRefName = `${newRefName}${inputSuffix}`;
            }
            refs.push(currentObj[key]);
            updateMainObjDefinition(mainObj, refPath, refName, newRefName, prefix, suffix, refs, inputSuffix);
        } else if (typeof currentObj[key] === 'object') {
            addPrefixSuffixToRefs(mainObj, currentObj[key], prefix, suffix, refs, inputSuffix);
        }
    }
    return mainObj;
};

const removeUnusedModels = (mainObj, refs) => {
    const removeUnused = (obj, type) => {
        for (const key in obj) {
            const ref = `#/${type}/${key}`;
            if (!refs.includes(ref)) {
                delete obj[key];
            }
        }
    };

    removeUnused(mainObj.definitions, 'definitions');
    removeUnused(mainObj.responses, 'responses');
    removeUnused(mainObj.parameters, 'parameters');

    return mainObj;
};

const getOpenApiConfig = (refs) => {
    const openApiConfig = {
        additionalProperties: {
            generateAliasAsModel: true,
            modelDocs: false,
            apiDocs: false,
            customNames: {}
        }
    };

    refs.forEach(ref => {
        const [, , refName] = ref.split('/');
        openApiConfig.additionalProperties.customNames[camelize(refName)] = refName;
    });

    return openApiConfig;
};
const checkAdditionalProperties = (obj) => {
    for (const key in obj) {
        if (Object.hasOwnProperty.call(obj, key)) {
            if (key === 'Dictionaries') {
                for (const propertyKey in obj[key].properties) {
                    if (Object.hasOwnProperty.call(obj[key].properties, propertyKey)) {
                        obj[key].properties[propertyKey].type = 'array';
                        obj[key].properties[propertyKey].items = { $ref: obj[key].properties[propertyKey].$ref };
                        delete obj[key].properties[propertyKey].$ref;
                    }
                }
            } else if (key === 'additionalProperties' && obj.properties) {
                obj.properties.additionalProperties = obj.additionalProperties;
            } else if (typeof obj[key] === 'object') {
                checkAdditionalProperties(obj[key]);
            }
        }
    }
}
const createNewDefinitionsForObjectAndArrayFields = (mainObj) => {
    const createNewDefinition = (obj) => {
        if (obj.properties) {
            for (const key in obj.properties) {
                if (Object.hasOwnProperty.call(obj.properties, key)) {
                    const property = obj.properties[key];
                    if (property.type === 'object' && property.properties && !property.properties.$ref && property.title) {
                        const title = property.title;
                        mainObj.definitions[title] = { ...property };
                        obj.properties[key] = { $ref: `#/definitions/${title}` };
                        createNewDefinition(mainObj.definitions[title]);
                    } else if (property.type === 'array' && property.items && !property.items.$ref && property.items.title && property.items.properties) {
                        const title = property.items.title;
                        mainObj.definitions[title] = { ...property.items };
                        property.items = { $ref: `#/definitions/${title}` };
                        createNewDefinition(mainObj.definitions[title]);
                    }
                }
            }
        } else if (obj.allOf) {
            obj.allOf.forEach(item => {
                if (!item.$ref && item.properties) {
                    createNewDefinition(item);
                }
            });
        } else if (obj.schema && obj.schema.title && obj.schema.properties && !obj.schema.properties.$ref) {
            const title = obj.schema.title;
            mainObj.definitions[title] = { ...obj.schema };
            obj.schema = { $ref: `#/definitions/${title}` };
        }
    };

    const createNewDefinitions = (obj) => {
        if (Array.isArray(obj)) {
            obj.forEach(item => createNewDefinition(item));
        } else {
            for (const key in obj) {
                if (Object.hasOwnProperty.call(obj, key)) {
                    createNewDefinition(obj[key]);
                }
            }
        }
    };

    createNewDefinitions(mainObj.definitions);
    createNewDefinitions(mainObj.responses);
    createNewDefinitions(mainObj.parameters);

    for (const apiPath in mainObj.paths) {
        for (const method in mainObj.paths[apiPath]) {
            if (Object.hasOwnProperty.call(mainObj.paths[apiPath], method)) {
                const pathMethod = mainObj.paths[apiPath][method];
                createNewDefinitions(pathMethod.responses);
                createNewDefinitions(pathMethod.parameters);
            }
        }
    }

    return mainObj;
};

const modifySwaggerFile = async (inputFilePath, outputFilePath, configMapping, openApiConfigOutputPath) => {
    try {
        let api = await SwaggerParser.bundle(inputFilePath);
        api = createNewDefinitionsForObjectAndArrayFields(api);
        checkAdditionalProperties(api.definitions);
        checkAdditionalProperties(api.responses);
        checkAdditionalProperties(api.parameters);

        const refs = [];
        for (const apiPath in api.paths) {
            for (const method in api.paths[apiPath]) {
                let inputSuffix = '', prefix = '', suffix = '';
                if (configMapping) {
                    prefix = configMapping.prefix || '';
                    suffix = configMapping.suffix || '';
                    inputSuffix = configMapping.inputSuffix || '';
                    if (configMapping[apiPath]?.[method]) {
                        prefix += configMapping[apiPath][method].prefix || '';
                        suffix += configMapping[apiPath][method].suffix || '';
                        inputSuffix += configMapping[apiPath][method].inputSuffix || '';
                    }
                }
                addPrefixSuffixToRefs(api, api.paths[apiPath][method].responses, prefix, suffix, refs);
                addPrefixSuffixToRefs(api, api.paths[apiPath][method].parameters, prefix, suffix, refs, inputSuffix);
            }
        }
        removeUnusedModels(api, refs);
        await writeJsonToFile(outputFilePath, api);
        if (openApiConfigOutputPath) {
            const openApiConfig = getOpenApiConfig(refs);
            await writeJsonToFile(openApiConfigOutputPath, openApiConfig);
        }
    } catch (err) {
        console.error('Error modifying Swagger file:', err);
    }
};

if (!options.input || !options.output) {
    console.error('Error: Input file path and output directory path required.');
    process.exit(1);
}

const processConfigMapping = async (configFilePath) => {
    try {
        const configMapping = await fs.readJson(configFilePath);
        await modifySwaggerFile(options.input, options.output, configMapping, options.openApiConfigOutputPath);
    } catch (err) {
        console.error('Error reading operation mapping file:', err);
    }
};

if (options.config) {
    processConfigMapping(options.config);
} else {
    modifySwaggerFile(options.input, options.output, null, options.openApiConfigOutputPath);
}