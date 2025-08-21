# WikiFunctions MCP Server

This project is a Model Context Protocol (MCP) server designed to interact with [WikiFunctions](https://www.wikifunctions.org/), a Wikimedia project for creating, curating, and sharing code.

This server exposes the functionality of WikiFunctions through the Model Context Protocol, allowing AI models and other tools to discover and execute functions from the WikiFunctions library.

## Quick Start

For MCP-compatible tools like Claude-Desktop or Cursor, you can enable this server by simply adding it to your `mcp.json` configuration file. The tool should handle the installation automatically.

```json
{
  "mcpServers": {
    "wikifunctions": {
      "command": "npx",
      "args": ["-y", "fredibau-wikifunctions-mcp"]
    }
  }
}
```

## Features

The server provides three main tools:

-   **`find_code`**: Searches for a function on WikiFunctions and returns its source code implementation. This is useful for inspection and understanding how a function works.
-   **`get_template`**: Fetches the definition of a WikiFunctions function and builds a JSON template for calling it. This template includes the function's name, description, and required arguments with their types.
-   **`run_template`**: Executes a function call on WikiFunctions using a provided template and argument values. It transforms the user-friendly template into the required format, makes the API call, and returns the result.

## How It Works

The server communicates with the WikiFunctions API to perform its operations.

1.  **Finding Functions**: When you use `find_code` or `get_template`, the server queries the WikiFunctions `wikilambdasearch_functions` API endpoint to find functions matching your search query.
2.  **Fetching Details**: Once a function is identified by its ZID (e.g., `Z804` for "add"), the server uses the `wikilambda_fetch` action to get detailed information, including argument definitions, implementations, and multilingual labels.
3.  **Building Templates**: The `get_template` tool parses the function details to construct a user-friendly JSON object that describes how to call the function. It resolves type ZIDs to human-readable names (e.g., `Z6` becomes "String").
4.  **Executing Functions**: The `run_template` tool takes a template and user-provided values, transforms them into a valid WikiFunctions function call object, and sends it to the `wikifunctions_run` API endpoint for execution. The result is then parsed and returned.

