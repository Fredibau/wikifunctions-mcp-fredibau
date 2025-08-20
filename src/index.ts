#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";
import {
  convertValueToZObject,
  convertZObjectToValue,
} from "./type-converter.js";

const WIKIFUNCTIONS_API_URL = "https://www.wikifunctions.org/w/api.php";

// --- Helper Functions ---

async function findFunctions(searchQuery: string): Promise<any[] | { error: string }> {
  const params = {
    action: "query",
    format: "json",
    list: "wikilambdasearch_functions",
    wikilambdasearch_functions_search: searchQuery,
    wikilambdasearch_functions_language: "en",
    wikilambdasearch_functions_limit: 10,
  };
  const headers = { "User-Agent": "MyWikiFunctionsTool/1.0" };

  try {
    const response = await axios.get(WIKIFUNCTIONS_API_URL, { params, headers });
    return response.data?.query?.wikilambdasearch_functions || [];
  } catch (e: any) {
    const error = e.response ? e.response.data : e.message;
    console.error(`Error searching for functions: ${error}`);
    return { error: `Error searching for functions: ${error}` };
  }
}

async function getFunctionDetails(functionId: string): Promise<any | null> {
  const params = {
    action: "wikilambda_fetch",
    format: "json",
    zids: functionId,
  };

  try {
    const response = await axios.get(WIKIFUNCTIONS_API_URL, { params, headers: { "User-Agent": "MyWikiFunctionsTool/1.0" } });
    const functionDataString = response.data[functionId]?.wikilambda_fetch;
    if (functionDataString) {
      return JSON.parse(functionDataString);
    }
  } catch (error: any) {
    console.error(`Error fetching details for ${functionId}:`, error.response ? error.response.data : error.message);
    return null;
  }
  return null;
}

function getImplementations(functionData: any): string[] {
  try {
    const implementationRefs = functionData?.Z2K2?.Z8K4?.slice(1) || [];
    return implementationRefs.map((impl: any) => typeof impl === 'string' ? impl : impl.Z14K1).filter(Boolean);
  } catch (error) {
    return [];
  }
}

async function getCode(implementationId: string): Promise<string | null> {
  const implementationData = await getFunctionDetails(implementationId);
  if (!implementationData) {
    return null;
  }
  try {
    const code = implementationData?.Z2K2?.Z14K3?.Z16K2;
    return code || null;
  } catch (error) {
    return null;
  }
}

function getEnglishLabel(multilingualList: any): string {
  if (!Array.isArray(multilingualList)) {
    return "N/A";
  }
  for (const item of multilingualList) {
    if (item && typeof item === "object" && item.Z11K1 === "Z1002") {
      return item.Z11K2 || "Label not found";
    }
  }
  return "English label not found";
}

async function getMultipleDetails(zids: string[]): Promise<Record<string, any>> {
  if (!zids || zids.length === 0) {
    return {};
  }

  const zidString = zids.join("|");
  const params = {
    action: "wikilambda_fetch",
    format: "json",
    zids: zidString,
  } as const;

  try {
    const response = await axios.get(WIKIFUNCTIONS_API_URL, {
      params,
      headers: { "User-Agent": "MyWikiFunctionsTool/1.0" },
    });
    const data = response.data || {};
    const results: Record<string, any> = {};
    for (const zid of zids) {
      const raw = data?.[zid]?.wikilambda_fetch;
      if (raw) {
        try {
          results[zid] = JSON.parse(raw);
        } catch {
          // ignore parse errors for individual entries
        }
      }
    }
    return results;
  } catch (error: any) {
    console.error(
      "Error fetching multiple details:",
      error.response ? error.response.data : error.message
    );
    return {};
  }
}

async function buildFunctionCallTemplate(funcDef: any): Promise<any> {
  try {
    const functionId = funcDef?.Z2K1?.Z6K1;
    const functionName = getEnglishLabel(funcDef?.Z2K3?.Z12K1);
    const functionDesc = getEnglishLabel(funcDef?.Z2K5?.Z12K1);
    const outputType = funcDef?.Z2K2?.Z8K2;

    const callTemplate: Record<string, any> = {
      _function_name: functionName,
      _function_description: functionDesc,
      _output_type: outputType,
      Z1K1: "Z7",
      Z7K1: functionId,
    };

    const argumentDefinitions: any[] = funcDef?.Z2K2?.Z8K1?.slice(1) || [];
    const typeZids = Array.from(
      new Set(
        argumentDefinitions
          .map((arg) => arg?.Z17K1)
          .filter((zid: any) => typeof zid === "string")
      )
    );

    const typeDetails = await getMultipleDetails(typeZids);
    const typeNameMap: Record<string, string> = {};
    for (const zid of typeZids) {
      const details = typeDetails[zid];
      const name = getEnglishLabel(details?.Z2K3?.Z12K1);
      typeNameMap[zid] = name || "Unknown";
    }

    for (const argDef of argumentDefinitions) {
      if (!argDef) continue;
      const argumentKey = argDef.Z17K2;
      const requiredTypeId = argDef.Z17K1;
      const argumentName = getEnglishLabel(argDef?.Z17K3?.Z12K1);
      const typeName = typeNameMap[requiredTypeId] || "Unknown";

      if (argumentKey) {
        callTemplate[argumentKey] = {
          name: argumentName,
          required_type: `${requiredTypeId} (${typeName})`,
          value: `<Provide a value for '${argumentName}'>`,
        };
      }
    }

    return callTemplate;
  } catch (error: any) {
    return { error: `Could not build template: ${error?.message || String(error)}` };
  }
}

function parseRequiredTypeZid(requiredType: string | undefined): string | null {
  if (!requiredType || typeof requiredType !== "string") return null;
  // Expected format: "Z123 (TypeName)" → take the first token starting with 'Z'
  const match = requiredType.match(/Z\d+/);
  return match ? match[0] : null;
}

function isAlreadyZObject(value: any): boolean {
  return value && typeof value === "object" && typeof value.Z1K1 === "string";
}

function transformTemplateToFunctionCall(
  template: any,
  providedValues: Record<string, unknown> = {}
): any {
  if (!template || typeof template !== "object") {
    throw new Error("Invalid template object");
  }

  const call: Record<string, any> = {
    Z1K1: "Z7",
    Z7K1: template.Z7K1,
  };

  const argumentKeys = Object.keys(template).filter(
    (k) => /^Z\d+K\d+$/.test(k) && template[k] && typeof template[k] === "object"
  );

  for (const argKey of argumentKeys) {
    const argDescriptor = template[argKey];
    const requiredTypeZid = parseRequiredTypeZid(argDescriptor?.required_type);

    // Resolve value priority: providedValues[argKey] → providedValues[name] → descriptor.value
    const nameKey = (argDescriptor?.name || "").toString();
    const provided =
      Object.prototype.hasOwnProperty.call(providedValues, argKey)
        ? providedValues[argKey]
        : Object.prototype.hasOwnProperty.call(providedValues, nameKey)
        ? (providedValues as any)[nameKey]
        : argDescriptor?.value;

    if (isAlreadyZObject(provided)) {
      call[argKey] = provided;
      continue;
    }

    // Fallback: if provided is still a placeholder string like <Provide ...>, throw
    if (typeof provided === "string" && /<\s*Provide\b/i.test(provided)) {
      throw new Error(
        `Missing value for argument '${argKey}' (${nameKey}). Please provide it in values_json.`
      );
    }

    // Wrap the primitive value in a Z-object, using the specific type from the template.
    if (!requiredTypeZid) {
      throw new Error(
        `Could not determine required type for argument '${argKey}' (${nameKey}) from the template.`
      );
    }

    call[argKey] = convertValueToZObject(provided, requiredTypeZid);
  }

  return call;
}

async function runWikifunctionCall(functionCall: any | string): Promise<{ raw: any; extracted?: any }> {
  const functionCallJson =
    typeof functionCall === "string" ? functionCall : JSON.stringify(functionCall);

  const params = {
    action: "wikifunctions_run",
    format: "json",
    formatversion: 2,
    function_call: functionCallJson,
  } as const;

  try {
    const response = await axios.get(WIKIFUNCTIONS_API_URL, {
      params,
      headers: { "User-Agent": "MyWikiFunctionsTool/1.0" },
    });
    const raw = response.data;
    const inner = raw?.wikifunctions_run?.data;
    if (typeof inner === "string") {
      try {
        const parsed = JSON.parse(inner);
        const extracted = parsed?.Z22K1?.Z13518K1 ?? parsed?.Z22K1 ?? parsed;
        return { raw: parsed, extracted };
      } catch {
        // Not JSON, return raw
        return { raw };
      }
    }
    return { raw };
  } catch (error: any) {
    throw new Error(
      `Error running Wikifunction call: ${error?.response?.data || error?.message || String(error)}`
    );
  }
}

const server = new McpServer({
  name: "wikifunctions",
  version: "1.0.0",
  capabilities: {
    resources: {},
    tools: {},
  },
});


server.tool(
  "find_code",
  "Finds the code implementation for a given search query on WikiFunctions. Use this tool if the User asks for the code of a function.",
  {
    search_query: z
      .string()
      .describe("The search query to find code for. Just a short string like 'add' or 'fibonacci'."),
  },
  async ({ search_query }) => {
    try {
      console.log(`Searching for code for query: "${search_query}"`);
      
      // Step 1: Find functions.
      const functionsResponse = await findFunctions(search_query);
      if ('error' in functionsResponse) {
        return { content: [{ type: "text", text: functionsResponse.error }] };
      }
      
      if (!functionsResponse || functionsResponse.length === 0) {
        return { content: [{ type: "text", text: `No functions found for '${search_query}'.` }] };
      }

      // Step 2: Iterate through functions.
      for (const func of functionsResponse) {
        const functionId = func.page_title;
        const label = func.label || 'N/A';
        console.log(`--- Checking function: ${functionId} (${label}) ---`);

        const functionData = await getFunctionDetails(functionId);
        if (!functionData) {
            console.log(`Could not retrieve details for function ${functionId}.`);
            continue;
        }

        const implementations = getImplementations(functionData);
        if (implementations.length === 0) {
            console.log(`No implementations found for function ${functionId}.`);
            continue;
        }

        // Step 3: Iterate through implementations.
        for (const implId of implementations) {
            console.log(`  Checking implementation: ${implId}...`);
            const code = await getCode(implId);
            if (code) {
                console.log(`  SUCCESS: Found code in implementation ${implId}`);
                return {
                    content: [
                        { type: "text", text: `\`\`\`\n${code}\n\`\`\`` },
                        { type: "text", text: `Found in implementation ${implId} of function ${functionId} (${label}).` }
                    ],
                };
            }
        }
        console.log(`No code found in any implementations for function ${functionId}.`);
      }
      
      return {
        content: [{ type: "text", text: `Operation complete. No code found for any function matching '${search_query}'.` }],
      };

    } catch (error: any) {
      console.error("Error in find_code:", error.response ? error.response.data : error.message);
      return {
        content: [{ type: "text", text: "Error searching for code." }],
      };
    }
  }
);

server.tool(
  "get_template",
  "Builds a function call template (with argument names and types) for a Wikifunctions function that matches the given query. Use this tool as the first tool if the User asks for the execution of a function or if your task requires the execution of a function.",
  {
    search_query: z
      .string()
      .describe(
        "The search query to find a function for. Just a string like 'add' or 'fibonacci'."
      ),
  },
  async ({ search_query }) => {
    try {
      console.log(`Searching for template for query: "${search_query}"`);

      // Step 1: Find functions.
      const functionsResponse = await findFunctions(search_query);
      if ("error" in functionsResponse) {
        return { content: [{ type: "text", text: functionsResponse.error }] };
      }

      if (!functionsResponse || functionsResponse.length === 0) {
        return {
          content: [
            { type: "text", text: `No functions found for '${search_query}'.` },
          ],
        };
      }

      // Step 2: Iterate through functions and build the first available template.
      for (const func of functionsResponse) {
        const functionId = func.page_title;
        const label = func.label || "N/A";
        console.log(`--- Building template for function: ${functionId} (${label}) ---`);

        const functionData = await getFunctionDetails(functionId);
        if (!functionData) {
          console.log(`Could not retrieve details for function ${functionId}.`);
          continue;
        }

        const template = await buildFunctionCallTemplate(functionData);
        if (template && !template.error) {
          return {
            content: [
              { type: "text", text: `\`\`\`\n${JSON.stringify(template, null, 2)}\n\`\`\`` },
              {
                type: "text",
                text: `Template built for function ${functionId} (${label}).`,
              },
            ],
          };
        }
      }

      return {
        content: [
          {
            type: "text",
            text: `Operation complete. No template could be built for any function matching '${search_query}'.`,
          },
        ],
      };
    } catch (error: any) {
      console.error(
        "Error in get_template:",
        error.response ? error.response.data : error.message
      );
      return {
        content: [{ type: "text", text: "Error building function template." }],
      };
    }
  }
);

server.tool(
  "run_template",
  "Transforms a function call template using provided values and executes it on Wikifunctions. Use this tool alwaysas the second tool if the User asks for the execution of a function or if your task requires the execution of a function.",
  {
    template_json: z
      .string()
      .describe("The function call template JSON string produced by get_template."),
    values_json: z
      .string()
      .optional()
      .describe(
        `Optional JSON object mapping argument names to their values. For example: '{"first number": 5, "second number": 7}'.`
      ),
  },
  async ({ template_json, values_json }) => {
    try {
      const template = JSON.parse(template_json);
      const values: Record<string, unknown> = values_json ? JSON.parse(values_json) : {};

      const callObject = transformTemplateToFunctionCall(template, values);
      const callJson = JSON.stringify(callObject, null, 2);

      const { raw } = await runWikifunctionCall(callObject);
      const extracted = convertZObjectToValue(raw?.Z22K1);

      const displayedResult =
        extracted && typeof extracted === "object"
          ? JSON.stringify(extracted, null, 2)
          : extracted ?? "<none>";

      const content: { type: "text"; text: string }[] = [
        { type: "text", text: `Constructed Call:` },
        { type: "text", text: `\`\`\`\n${callJson}\n\`\`\`` },
        { type: "text", text: `Result (extracted): ${displayedResult}` },
      ];

      if (raw?.Z22K1?.Z1K1 === "Z24") {
        content.push({
          type: "text",
          text: "Note: The result Z24 indicates an error, which could mean the implementation is flawed or the inputs were invalid. I will search for the code of the function and return it.",
        });
      }

      return { content };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `Error in run_template: ${error?.message || String(error)}`,
          },
        ],
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("WikiFunctions MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
