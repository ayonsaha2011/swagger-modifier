# Swagger Modifier

This tool modifies Swagger files by adding prefixes and suffixes to operation IDs and references.

## Installation

```bash
npm install -g swagger-modifier
```

## Usage

```bash
swagger-modifier -i <inputFilePath> -o <outputFilePath> -c <configMapping> -oc <openApiConfigOutputPath>
```

### Options:

-i, --input <inputFilePath>: Path to the input Swagger file.
-o, --output <outputFilePath>: Path to the output directory.
-c, --config <configMapping>: Path to the JSON file containing a map of operation IDs to prefixes and suffixes.
-oc --open-api-config-output-path <openApiConfigOutputPath>: Path to the output OpenAPI name mapping config file

### Example:

```bash
swagger-modifier -i swagger.json -o modified-swagger.json -c config.json -oc openAPINameMappingConfig.json
```

### config.json:

```bash
{
  "/users": {
    "get": {
      "prefix": "user_",
      "suffix": "_v1"
    },
    "post": {
      "prefix": "user_",
      "suffix": "_v1"
    }
  },
  "/products": {
    "get": {
      "prefix": "product_",
      "suffix": "_v1"
    }
  }
}

```

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## License

This project is licensed under the MIT License.
