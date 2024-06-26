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

const setOpenApiConfig = async (openApiConfigOutputPath, configMapping) => {
    try {
        let openApiConfig = await fs.readJson(openApiConfigOutputPath);
        if (!openApiConfig || typeof openApiConfig !== 'object') {
            openApiConfig = {
                "packageName": "flight-offers-search",
                "avoidBoxedModels": true,
            };
        }
        if (configMapping.packageName) {
            openApiConfig.packageName = configMapping.packageName;
        }
        await writeJsonToFile(openApiConfigOutputPath, openApiConfig);
    } catch (error) {
        console.error('Error reading operation mapping file:', err);
    }
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

const checkArrayEnums = (mainObj, arrayEnumsKey = []) => {
    for (const key in mainObj) {
        if (Object.hasOwnProperty.call(mainObj, key) && mainObj[key].type === 'array' && mainObj[key].items && mainObj[key].items.enum) {
            arrayEnumsKey.push(key);
        } else if (typeof mainObj[key] === 'object') {
            checkArrayEnums(mainObj[key], arrayEnumsKey);
        } else if (Array.isArray(mainObj[key])) {
            checkArrayEnums(mainObj[key][0], arrayEnumsKey);
        }
    }
}
const handleArrayEnums = (mainObj, currentObj, arrayEnumsKey = [], generatedObjects = {}) => {
    for (const key in currentObj) {
        if (key === '$ref' && currentObj[key] && currentObj[key].startsWith('#/')) {
            const [_, refPath, refName] = currentObj[key].split('/');
            if (arrayEnumsKey.includes(refName)) {
                if (mainObj[refPath][refName] && mainObj[refPath][refName].items && mainObj[refPath][refName].items.enum) {
                    currentObj.type = 'array';
                    currentObj.description = currentObj.description || mainObj[refPath][refName].description || '';
                    currentObj.minItems = currentObj.minItems || mainObj[refPath][refName].minItems || 0;
                    currentObj.maxItems = currentObj.maxItems || mainObj[refPath][refName].maxItems || 0;
                    currentObj.example = currentObj.example || mainObj[refPath][refName].example || [];
                    const newRefName = `${refName}Enum`;
                    currentObj.items = { $ref: `#/definitions/${newRefName}` };
                    mainObj.definitions[`${newRefName}`] = {
                        type: 'string',
                        enum: mainObj[refPath][refName].items.enum
                    };
                    delete mainObj[refPath][refName];
                    delete currentObj[key];
                    generatedObjects[newRefName] = { ...currentObj };
                } else {
                    const newRefName = `${refName}Enum`;
                    if (mainObj[refPath][newRefName] && mainObj[refPath][newRefName].enum && generatedObjects[newRefName]) {
                        currentObj.type = generatedObjects[newRefName].type;
                        currentObj.description = generatedObjects[newRefName].description;
                        currentObj.minItems = generatedObjects[newRefName].minItems;
                        currentObj.maxItems = generatedObjects[newRefName].maxItems;
                        currentObj.example = generatedObjects[newRefName].example;
                        currentObj.items = generatedObjects[newRefName].items;
                        delete currentObj[key];
                    }
                }
            } else if (typeof mainObj[refPath][refName] === 'object') {
                handleArrayEnums(mainObj, mainObj[refPath][refName], arrayEnumsKey, generatedObjects);
            } else if (Array.isArray(mainObj[refPath][refName])) {
                handleArrayEnums(mainObj, mainObj[refPath][refName][0], arrayEnumsKey, generatedObjects);
            }
        } else if (typeof currentObj[key] === 'object') {
            handleArrayEnums(mainObj, currentObj[key], arrayEnumsKey, generatedObjects);
        } else if (Array.isArray(currentObj[key])) {
            handleArrayEnums(mainObj, currentObj[key][0], arrayEnumsKey, generatedObjects);
        }
    }
}
const modifySwaggerFile = async (inputFilePath, outputFilePath, configMapping, openApiConfigOutputPath) => {
    try {
        let api = await SwaggerParser.bundle(inputFilePath);
        api = createNewDefinitionsForObjectAndArrayFields(api);
        checkAdditionalProperties(api.definitions);
        checkAdditionalProperties(api.responses);
        checkAdditionalProperties(api.parameters);
        const arrayEnumsKey = [];
        const generatedObjects = {};
        checkArrayEnums(api, arrayEnumsKey);
        handleArrayEnums(api, api.responses, arrayEnumsKey, generatedObjects);
        handleArrayEnums(api, api.parameters, arrayEnumsKey, generatedObjects);
        handleArrayEnums(api, api.definitions, arrayEnumsKey, generatedObjects);

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
            setOpenApiConfig(openApiConfigOutputPath, configMapping);
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