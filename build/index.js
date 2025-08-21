#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";
import { convertValueToZObject, convertZObjectToValue, } from "./type-converter.js";
const WIKIFUNCTIONS_API_URL = "https://www.wikifunctions.org/w/api.php";
// --- Helper Functions ---
async function findFunctions(searchQuery) {
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
    }
    catch (e) {
        const error = e.response ? e.response.data : e.message;
        console.error(`Error searching for functions: ${error}`);
        return { error: `Error searching for functions: ${error}` };
    }
}
async function getFunctionDetails(functionId) {
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
    }
    catch (error) {
        console.error(`Error fetching details for ${functionId}:`, error.response ? error.response.data : error.message);
        return null;
    }
    return null;
}
function getImplementations(functionData) {
    try {
        const implementationRefs = functionData?.Z2K2?.Z8K4?.slice(1) || [];
        return implementationRefs.map((impl) => typeof impl === 'string' ? impl : impl.Z14K1).filter(Boolean);
    }
    catch (error) {
        return [];
    }
}
async function getCode(implementationId) {
    const implementationData = await getFunctionDetails(implementationId);
    if (!implementationData) {
        return null;
    }
    try {
        const code = implementationData?.Z2K2?.Z14K3?.Z16K2;
        return code || null;
    }
    catch (error) {
        return null;
    }
}
function getEnglishLabel(multilingualList) {
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
async function getMultipleDetails(zids) {
    if (!zids || zids.length === 0) {
        return {};
    }
    const zidString = zids.join("|");
    const params = {
        action: "wikilambda_fetch",
        format: "json",
        zids: zidString,
    };
    try {
        const response = await axios.get(WIKIFUNCTIONS_API_URL, {
            params,
            headers: { "User-Agent": "MyWikiFunctionsTool/1.0" },
        });
        const data = response.data || {};
        const results = {};
        for (const zid of zids) {
            const raw = data?.[zid]?.wikilambda_fetch;
            if (raw) {
                try {
                    results[zid] = JSON.parse(raw);
                }
                catch {
                    // ignore parse errors for individual entries
                }
            }
        }
        return results;
    }
    catch (error) {
        console.error("Error fetching multiple details:", error.response ? error.response.data : error.message);
        return {};
    }
}
async function buildFunctionCallTemplate(funcDef) {
    try {
        const functionId = funcDef?.Z2K1?.Z6K1;
        const functionName = getEnglishLabel(funcDef?.Z2K3?.Z12K1);
        const functionDesc = getEnglishLabel(funcDef?.Z2K5?.Z12K1);
        const outputType = funcDef?.Z2K2?.Z8K2;
        const callTemplate = {
            _function_name: functionName,
            _function_description: functionDesc,
            _output_type: outputType,
            Z1K1: "Z7",
            Z7K1: functionId,
        };
        const argumentDefinitions = funcDef?.Z2K2?.Z8K1?.slice(1) || [];
        const typeZids = Array.from(new Set(argumentDefinitions
            .map((arg) => arg?.Z17K1)
            .filter((zid) => typeof zid === "string")));
        const typeDetails = await getMultipleDetails(typeZids);
        const typeNameMap = {};
        for (const zid of typeZids) {
            const details = typeDetails[zid];
            const name = getEnglishLabel(details?.Z2K3?.Z12K1);
            typeNameMap[zid] = name || "Unknown";
        }
        for (const argDef of argumentDefinitions) {
            if (!argDef)
                continue;
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
    }
    catch (error) {
        return { error: `Could not build template: ${error?.message || String(error)}` };
    }
}
function parseRequiredTypeZid(requiredType) {
    if (!requiredType || typeof requiredType !== "string")
        return null;
    // Expected format: "Z123 (TypeName)" → take the first token starting with 'Z'
    const match = requiredType.match(/Z\d+/);
    return match ? match[0] : null;
}
function isAlreadyZObject(value) {
    return value && typeof value === "object" && typeof value.Z1K1 === "string";
}
function transformTemplateToFunctionCall(template, providedValues = {}) {
    if (!template || typeof template !== "object") {
        throw new Error("Invalid template object");
    }
    const call = {
        Z1K1: "Z7",
        Z7K1: template.Z7K1,
    };
    const argumentKeys = Object.keys(template).filter((k) => /^Z\d+K\d+$/.test(k) && template[k] && typeof template[k] === "object");
    for (const argKey of argumentKeys) {
        const argDescriptor = template[argKey];
        const requiredTypeZid = parseRequiredTypeZid(argDescriptor?.required_type);
        // Resolve value priority: providedValues[argKey] → providedValues[name] → descriptor.value
        const nameKey = (argDescriptor?.name || "").toString();
        const provided = Object.prototype.hasOwnProperty.call(providedValues, argKey)
            ? providedValues[argKey]
            : Object.prototype.hasOwnProperty.call(providedValues, nameKey)
                ? providedValues[nameKey]
                : argDescriptor?.value;
        if (isAlreadyZObject(provided)) {
            call[argKey] = provided;
            continue;
        }
        // Fallback: if provided is still a placeholder string like <Provide ...>, throw
        if (typeof provided === "string" && /<\s*Provide\b/i.test(provided)) {
            throw new Error(`Missing value for argument '${argKey}' (${nameKey}). Please provide it in values_json.`);
        }
        // Wrap the primitive value in a Z-object, using the specific type from the template.
        if (!requiredTypeZid) {
            throw new Error(`Could not determine required type for argument '${argKey}' (${nameKey}) from the template.`);
        }
        call[argKey] = convertValueToZObject(provided, requiredTypeZid);
    }
    return call;
}
async function runWikifunctionCall(functionCall) {
    const functionCallJson = typeof functionCall === "string" ? functionCall : JSON.stringify(functionCall);
    const params = {
        action: "wikifunctions_run",
        format: "json",
        formatversion: 2,
        function_call: functionCallJson,
    };
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
            }
            catch {
                // Not JSON, return raw
                return { raw };
            }
        }
        return { raw };
    }
    catch (error) {
        throw new Error(`Error running Wikifunction call: ${error?.response?.data || error?.message || String(error)}`);
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
server.tool("find_code", "Finds the code implementation for a given search query on WikiFunctions. Use this tool if the User asks for the code of a function.", {
    search_query: z
        .string()
        .describe("The search query to find code for. Just a short string like 'add' or 'fibonacci'."),
}, async ({ search_query }) => {
    try {
        console.error(`Searching for code for query: "${search_query}"`);
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
            console.error(`--- Checking function: ${functionId} (${label}) ---`);
            const functionData = await getFunctionDetails(functionId);
            if (!functionData) {
                console.error(`Could not retrieve details for function ${functionId}.`);
                continue;
            }
            const implementations = getImplementations(functionData);
            if (implementations.length === 0) {
                console.error(`No implementations found for function ${functionId}.`);
                continue;
            }
            // Step 3: Iterate through implementations.
            for (const implId of implementations) {
                console.error(`  Checking implementation: ${implId}...`);
                const code = await getCode(implId);
                if (code) {
                    console.error(`  SUCCESS: Found code in implementation ${implId}`);
                    return {
                        content: [
                            { type: "text", text: `\`\`\`\n${code}\n\`\`\`` },
                            { type: "text", text: `Found in implementation ${implId} of function ${functionId} (${label}).` }
                        ],
                    };
                }
            }
            console.error(`No code found in any implementations for function ${functionId}.`);
        }
        return {
            content: [{ type: "text", text: `Operation complete. No code found for any function matching '${search_query}'.` }],
        };
    }
    catch (error) {
        console.error("Error in find_code:", error.response ? error.response.data : error.message);
        return {
            content: [{ type: "text", text: "Error searching for code." }],
        };
    }
});
server.tool("get_template", "Builds a function call template (with argument names and types) for a Wikifunctions function that matches the given query. Use this tool as the first tool if the User asks for the execution of a function or if your task requires the execution of a function.", {
    search_query: z
        .string()
        .describe("The search query to find a function for. Just a string like 'add' or 'fibonacci'."),
}, async ({ search_query }) => {
    try {
        console.error(`Searching for template for query: "${search_query}"`);
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
            console.error(`--- Building template for function: ${functionId} (${label}) ---`);
            const functionData = await getFunctionDetails(functionId);
            if (!functionData) {
                console.error(`Could not retrieve details for function ${functionId}.`);
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
    }
    catch (error) {
        console.error("Error in get_template:", error.response ? error.response.data : error.message);
        return {
            content: [{ type: "text", text: "Error building function template." }],
        };
    }
});
server.tool("run_template", "Transforms a function call template using provided values and executes it on Wikifunctions. Use this tool alwaysas the second tool if the User asks for the execution of a function or if your task requires the execution of a function.", {
    template_json: z
        .string()
        .describe("The function call template JSON string produced by get_template."),
    values_json: z
        .string()
        .optional()
        .describe(`Optional JSON object mapping argument names to their values. For example: '{"first number": 5, "second number": 7}'.`),
}, async ({ template_json, values_json }) => {
    try {
        const template = JSON.parse(template_json);
        const values = values_json ? JSON.parse(values_json) : {};
        const callObject = transformTemplateToFunctionCall(template, values);
        const callJson = JSON.stringify(callObject, null, 2);
        const { raw } = await runWikifunctionCall(callObject);
        const extracted = convertZObjectToValue(raw?.Z22K1);
        const displayedResult = extracted && typeof extracted === "object"
            ? JSON.stringify(extracted, null, 2)
            : extracted ?? "<none>";
        const content = [
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
    }
    catch (error) {
        return {
            content: [
                {
                    type: "text",
                    text: `Error in run_template: ${error?.message || String(error)}`,
                },
            ],
        };
    }
});
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("WikiFunctions MCP Server running on stdio");
}
main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUVBLE9BQU8sRUFBRSxTQUFTLEVBQUUsTUFBTSx5Q0FBeUMsQ0FBQztBQUNwRSxPQUFPLEVBQUUsb0JBQW9CLEVBQUUsTUFBTSwyQ0FBMkMsQ0FBQztBQUNqRixPQUFPLEVBQUUsQ0FBQyxFQUFFLE1BQU0sS0FBSyxDQUFDO0FBQ3hCLE9BQU8sS0FBSyxNQUFNLE9BQU8sQ0FBQztBQUMxQixPQUFPLEVBQ0wscUJBQXFCLEVBQ3JCLHFCQUFxQixHQUN0QixNQUFNLHFCQUFxQixDQUFDO0FBRTdCLE1BQU0scUJBQXFCLEdBQUcseUNBQXlDLENBQUM7QUFFeEUsMkJBQTJCO0FBRTNCLEtBQUssVUFBVSxhQUFhLENBQUMsV0FBbUI7SUFDOUMsTUFBTSxNQUFNLEdBQUc7UUFDYixNQUFNLEVBQUUsT0FBTztRQUNmLE1BQU0sRUFBRSxNQUFNO1FBQ2QsSUFBSSxFQUFFLDRCQUE0QjtRQUNsQyxpQ0FBaUMsRUFBRSxXQUFXO1FBQzlDLG1DQUFtQyxFQUFFLElBQUk7UUFDekMsZ0NBQWdDLEVBQUUsRUFBRTtLQUNyQyxDQUFDO0lBQ0YsTUFBTSxPQUFPLEdBQUcsRUFBRSxZQUFZLEVBQUUseUJBQXlCLEVBQUUsQ0FBQztJQUU1RCxJQUFJLENBQUM7UUFDSCxNQUFNLFFBQVEsR0FBRyxNQUFNLEtBQUssQ0FBQyxHQUFHLENBQUMscUJBQXFCLEVBQUUsRUFBRSxNQUFNLEVBQUUsT0FBTyxFQUFFLENBQUMsQ0FBQztRQUM3RSxPQUFPLFFBQVEsQ0FBQyxJQUFJLEVBQUUsS0FBSyxFQUFFLDBCQUEwQixJQUFJLEVBQUUsQ0FBQztJQUNoRSxDQUFDO0lBQUMsT0FBTyxDQUFNLEVBQUUsQ0FBQztRQUNoQixNQUFNLEtBQUssR0FBRyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLElBQUksQ0FB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QUFPLEVBQUU7Z0JBQ1A7b0JBQ0UsSUFBSSxFQUFFLE1BQU07b0JBQ1osSUFBSSxFQUFFLDBCQUEwQixLQUFLLEVBQUUsT0FBTyxJQUFJLE1BQU0sQ0FBQyxLQUFLLENBQUMsRUFBRTtpQkFDbEU7YUFDRjtTQUNGLENBQUM7SUFDSixDQUFDO0FBQ0gsQ0FBQyxDQUNGLENBQUM7QUFFRixLQUFLLFVBQVUsSUFBSTtJQUNqQixNQUFNLFNBQVMsR0FBRyxJQUFJLG9CQUFvQixFQUFFLENBQUM7SUFDN0MsTUFBTSxNQUFNLENBQUMsT0FBTyxDQUFDLFNBQVMsQ0FBQyxDQUFDO0lBQ2hDLE9BQU8sQ0FBQyxLQUFLLENBQUMsMkNBQTJDLENBQUMsQ0FBQztBQUM3RCxDQUFDO0FBRUQsSUFBSSxFQUFFLENBQUMsS0FBSyxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUU7SUFDckIsT0FBTyxDQUFDLEtBQUssQ0FBQyx3QkFBd0IsRUFBRSxLQUFLLENBQUMsQ0FBQztJQUMvQyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ2xCLENBQUMsQ0FBQyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiIyEvdXNyL2Jpbi9lbnYgbm9kZVxuXG5pbXBvcnQgeyBNY3BTZXJ2ZXIgfSBmcm9tIFwiQG1vZGVsY29udGV4dHByb3RvY29sL3Nkay9zZXJ2ZXIvbWNwLmpzXCI7XG5pbXBvcnQgeyBTdGRpb1NlcnZlclRyYW5zcG9ydCB9IGZyb20gXCJAbW9kZWxjb250ZXh0cHJvdG9jb2wvc2RrL3NlcnZlci9zdGRpby5qc1wiO1xuaW1wb3J0IHsgeiB9IGZyb20gXCJ6b2RcIjtcbmltcG9ydCBheGlvcyBmcm9tIFwiYXhpb3NcIjtcbmltcG9ydCB7XG4gIGNvbnZlcnRWYWx1ZVRvWk9iamVjdCxcbiAgY29udmVydFpPYmplY3RUb1ZhbHVlLFxufSBmcm9tIFwiLi90eXBlLWNvbnZlcnRlci5qc1wiO1xuXG5jb25zdCBXSUtJRlVOQ1RJT05TX0FQSV9VUkwgPSBcImh0dHBzOi8vd3d3Lndpa2lmdW5jdGlvbnMub3JnL3cvYXBpLnBocFwiO1xuXG4vLyAtLS0gSGVscGVyIEZ1bmN0aW9ucyAtLS1cblxuYXN5bmMgZnVuY3Rpb24gZmluZEZ1bmN0aW9ucyhzZWFyY2hRdWVyeTogc3RyaW5nKTogUHJvbWlzZTxhbnlbXSB8IHsgZXJyb3I6IHN0cmluZyB9PiB7XG4gIGNvbnN0IHBhcmFtcyA9IHtcbiAgICBhY3Rpb246IFwicXVlcnlcIixcbiAgICBmb3JtYXQ6IFwianNvblwiLFxuICAgIGxpc3Q6IFwid2lraWxhbWJkYXNlYXJjaF9mdW5jdGlvbnNcIixcbiAgICB3aWtpbGFtYmRhc2VhcmNoX2Z1bmN0aW9uc19zZWFyY2g6IHNlYXJjaFF1ZXJ5LFxuICAgIHdpa2lsYW1iZGFzZWFyY2hfZnVuY3Rpb25zX2xhbmd1YWdlOiBcImVuXCIsXG4gICAgd2lraWxhbWJkYXNlYXJjaF9mdW5jdGlvbnNfbGltaXQ6IDEwLFxuICB9O1xuICBjb25zdCBoZWFkZXJzID0geyBcIlVzZXItQWdlbnRcIjogXCJNeVdpa2lGdW5jdGlvbnNUb29sLzEuMFwiIH07XG5cbiAgdHJ5IHtcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGF4aW9zLmdldChXSUtJRlVOQ1RJT05TX0FQSV9VUkwsIHsgcGFyYW1zLCBoZWFkZXJzIH0pO1xuICAgIHJldHVybiByZXNwb25zZS5kYXRhPy5xdWVyeT8ud2lraWxhbWJkYXNlYXJjaF9mdW5jdGlvbnMgfHwgW107XG4gIH0gY2F0Y2ggKGU6IGFueSkge1xuICAgIGNvbnN0IGVycm9yID0gZS5yZXNwb25zZSA/IGUucmVzcG9uc2UuZGF0YSA6IGUubWVzc2FnZTtcbiAgICBjb25zb2xlLmVycm9yKGBFcnJvciBzZWFyY2hpbmcgZm9yIGZ1bmN0aW9uczogJHtlcnJvcn1gKTtcbiAgICByZXR1cm4geyBlcnJvcjogYEVycm9yIHNlYXJjaGluZyBmb3IgZnVuY3Rpb25zOiAke2Vycm9yfWAgfTtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBnZXRGdW5jdGlvbkRldGFpbHMoZnVuY3Rpb25JZDogc3RyaW5nKTogUHJvbWlzZTxhbnkgfCBudWxsPiB7XG4gIGNvbnN0IHBhcmFtcyA9IHtcbiAgICBhY3Rpb246IFwid2lraWxhbWJkYV9mZXRjaFwiLFxuICAgIGZvcm1hdDogXCJqc29uXCIsXG4gICAgemlkczogZnVuY3Rpb25JZCxcbiAgfTtcblxuICB0cnkge1xuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgYXhpb3MuZ2V0KFdJS0lGVU5DVElPTlNfQVBJX1VSTCwgeyBwYXJhbXMsIGhlYWRlcnM6IHsgXCJVc2VyLUFnZW50XCI6IFwiTXlXaWtpRnVuY3Rpb25zVG9vbC8xLjBcIiB9IH0pO1xuICAgIGNvbnN0IGZ1bmN0aW9uRGF0YVN0cmluZyA9IHJlc3BvbnNlLmRhdGFbZnVuY3Rpb25JZF0/Lndpa2lsYW1iZGFfZmV0Y2g7XG4gICAgaWYgKGZ1bmN0aW9uRGF0YVN0cmluZykge1xuICAgICAgcmV0dXJuIEpTT04ucGFyc2UoZnVuY3Rpb25EYXRhU3RyaW5nKTtcbiAgICB9XG4gIH0gY2F0Y2ggKGVycm9yOiBhbnkpIHtcbiAgICBjb25zb2xlLmVycm9yKGBFcnJvciBmZXRjaGluZyBkZXRhaWxzIGZvciAke2Z1bmN0aW9uSWR9OmAsIGVycm9yLnJlc3BvbnNlID8gZXJyb3IucmVzcG9uc2UuZGF0YSA6IGVycm9yLm1lc3NhZ2UpO1xuICAgIHJldHVybiBudWxsO1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiBnZXRJbXBsZW1lbnRhdGlvbnMoZnVuY3Rpb25EYXRhOiBhbnkpOiBzdHJpbmdbXSB7XG4gIHRyeSB7XG4gICAgY29uc3QgaW1wbGVtZW50YXRpb25SZWZzID0gZnVuY3Rpb25EYXRhPy5aMksyPy5aOEs0Py5zbGljZSgxKSB8fCBbXTtcbiAgICByZXR1cm4gaW1wbGVtZW50YXRpb25SZWZzLm1hcCgoaW1wbDogYW55KSA9PiB0eXBlb2YgaW1wbCA9PT0gJ3N0cmluZycgPyBpbXBsIDogaW1wbC5aMTRLMSkuZmlsdGVyKEJvb2xlYW4pO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIHJldHVybiBbXTtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBnZXRDb2RlKGltcGxlbWVudGF0aW9uSWQ6IHN0cmluZyk6IFByb21pc2U8c3RyaW5nIHwgbnVsbD4ge1xuICBjb25zdCBpbXBsZW1lbnRhdGlvbkRhdGEgPSBhd2FpdCBnZXRGdW5jdGlvbkRldGFpbHMoaW1wbGVtZW50YXRpb25JZCk7XG4gIGlmICghaW1wbGVtZW50YXRpb25EYXRhKSB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgdHJ5IHtcbiAgICBjb25zdCBjb2RlID0gaW1wbGVtZW50YXRpb25EYXRhPy5aMksyPy5aMTRLMz8uWjE2SzI7XG4gICAgcmV0dXJuIGNvZGUgfHwgbnVsbDtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG5mdW5jdGlvbiBnZXRFbmdsaXNoTGFiZWwobXVsdGlsaW5ndWFsTGlzdDogYW55KTogc3RyaW5nIHtcbiAgaWYgKCFBcnJheS5pc0FycmF5KG11bHRpbGluZ3VhbExpc3QpKSB7XG4gICAgcmV0dXJuIFwiTi9BXCI7XG4gIH1cbiAgZm9yIChjb25zdCBpdGVtIG9mIG11bHRpbGluZ3VhbExpc3QpIHtcbiAgICBpZiAoaXRlbSAmJiB0eXBlb2YgaXRlbSA9PT0gXCJvYmplY3RcIiAmJiBpdGVtLloxMUsxID09PSBcIloxMDAyXCIpIHtcbiAgICAgIHJldHVybiBpdGVtLloxMUsyIHx8IFwiTGFiZWwgbm90IGZvdW5kXCI7XG4gICAgfVxuICB9XG4gIHJldHVybiBcIkVuZ2xpc2ggbGFiZWwgbm90IGZvdW5kXCI7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGdldE11bHRpcGxlRGV0YWlscyh6aWRzOiBzdHJpbmdbXSk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgYW55Pj4ge1xuICBpZiAoIXppZHMgfHwgemlkcy5sZW5ndGggPT09IDApIHtcbiAgICByZXR1cm4ge307XG4gIH1cblxuICBjb25zdCB6aWRTdHJpbmcgPSB6aWRzLmpvaW4oXCJ8XCIpO1xuICBjb25zdCBwYXJhbXMgPSB7XG4gICAgYWN0aW9uOiBcIndpa2lsYW1iZGFfZmV0Y2hcIixcbiAgICBmb3JtYXQ6IFwianNvblwiLFxuICAgIHppZHM6IHppZFN0cmluZyxcbiAgfSBhcyBjb25zdDtcblxuICB0cnkge1xuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgYXhpb3MuZ2V0KFdJS0lGVU5DVElPTlNfQVBJX1VSTCwge1xuICAgICAgcGFyYW1zLFxuICAgICAgaGVhZGVyczogeyBcIlVzZXItQWdlbnRcIjogXCJNeVdpa2lGdW5jdGlvbnNUb29sLzEuMFwiIH0sXG4gICAgfSk7XG4gICAgY29uc3QgZGF0YSA9IHJlc3BvbnNlLmRhdGEgfHwge307XG4gICAgY29uc3QgcmVzdWx0czogUmVjb3JkPHN0cmluZywgYW55PiA9IHt9O1xuICAgIGZvciAoY29uc3QgemlkIG9mIHppZHMpIHtcbiAgICAgIGNvbnN0IHJhdyA9IGRhdGE/Llt6aWRdPy53aWtpbGFtYmRhX2ZldGNoO1xuICAgICAgaWYgKHJhdykge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHJlc3VsdHNbemlkXSA9IEpTT04ucGFyc2UocmF3KTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgLy8gaWdub3JlIHBhcnNlIGVycm9ycyBmb3IgaW5kaXZpZHVhbCBlbnRyaWVzXG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHJlc3VsdHM7XG4gIH0gY2F0Y2ggKGVycm9yOiBhbnkpIHtcbiAgICBjb25zb2xlLmVycm9yKFxuICAgICAgXCJFcnJvciBmZXRjaGluZyBtdWx0aXBsZSBkZXRhaWxzOlwiLFxuICAgICAgZXJyb3IucmVzcG9uc2UgPyBlcnJvci5yZXNwb25zZS5kYXRhIDogZXJyb3IubWVzc2FnZVxuICAgICk7XG4gICAgcmV0dXJuIHt9O1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGJ1aWxkRnVuY3Rpb25DYWxsVGVtcGxhdGUoZnVuY0RlZjogYW55KTogUHJvbWlzZTxhbnk+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBmdW5jdGlvbklkID0gZnVuY0RlZj8uWjJLMT8uWjZLMTtcbiAgICBjb25zdCBmdW5jdGlvbk5hbWUgPSBnZXRFbmdsaXNoTGFiZWwoZnVuY0RlZj8uWjJLMz8uWjEySzEpO1xuICAgIGNvbnN0IGZ1bmN0aW9uRGVzYyA9IGdldEVuZ2xpc2hMYWJlbChmdW5jRGVmPy5aMks1Py5aMTJLMSk7XG4gICAgY29uc3Qgb3V0cHV0VHlwZSA9IGZ1bmNEZWY/LloySzI/Llo4SzI7XG5cbiAgICBjb25zdCBjYWxsVGVtcGxhdGU6IFJlY29yZDxzdHJpbmcsIGFueT4gPSB7XG4gICAgICBfZnVuY3Rpb25fbmFtZTogZnVuY3Rpb25OYW1lLFxuICAgICAgX2Z1bmN0aW9uX2Rlc2NyaXB0aW9uOiBmdW5jdGlvbkRlc2MsXG4gICAgICBfb3V0cHV0X3R5cGU6IG91dHB1dFR5cGUsXG4gICAgICBaMUsxOiBcIlo3XCIsXG4gICAgICBaN0sxOiBmdW5jdGlvbklkLFxuICAgIH07XG5cbiAgICBjb25zdCBhcmd1bWVudERlZmluaXRpb25zOiBhbnlbXSA9IGZ1bmNEZWY/LloySzI/Llo4SzE/LnNsaWNlKDEpIHx8IFtdO1xuICAgIGNvbnN0IHR5cGVaaWRzID0gQXJyYXkuZnJvbShcbiAgICAgIG5ldyBTZXQoXG4gICAgICAgIGFyZ3VtZW50RGVmaW5pdGlvbnNcbiAgICAgICAgICAubWFwKChhcmcpID0+IGFyZz8uWjE3SzEpXG4gICAgICAgICAgLmZpbHRlcigoemlkOiBhbnkpID0+IHR5cGVvZiB6aWQgPT09IFwic3RyaW5nXCIpXG4gICAgICApXG4gICAgKTtcblxuICAgIGNvbnN0IHR5cGVEZXRhaWxzID0gYXdhaXQgZ2V0TXVsdGlwbGVEZXRhaWxzKHR5cGVaaWRzKTtcbiAgICBjb25zdCB0eXBlTmFtZU1hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuICAgIGZvciAoY29uc3QgemlkIG9mIHR5cGVaaWRzKSB7XG4gICAgICBjb25zdCBkZXRhaWxzID0gdHlwZURldGFpbHNbemlkXTtcbiAgICAgIGNvbnN0IG5hbWUgPSBnZXRFbmdsaXNoTGFiZWwoZGV0YWlscz8uWjJLMz8uWjEySzEpO1xuICAgICAgdHlwZU5hbWVNYXBbemlkXSA9IG5hbWUgfHwgXCJVbmtub3duXCI7XG4gICAgfVxuXG4gICAgZm9yIChjb25zdCBhcmdEZWYgb2YgYXJndW1lbnREZWZpbml0aW9ucykge1xuICAgICAgaWYgKCFhcmdEZWYpIGNvbnRpbnVlO1xuICAgICAgY29uc3QgYXJndW1lbnRLZXkgPSBhcmdEZWYuWjE3SzI7XG4gICAgICBjb25zdCByZXF1aXJlZFR5cGVJZCA9IGFyZ0RlZi5aMTdLMTtcbiAgICAgIGNvbnN0IGFyZ3VtZW50TmFtZSA9IGdldEVuZ2xpc2hMYWJlbChhcmdEZWY/LloxN0szPy5aMTJLMSk7XG4gICAgICBjb25zdCB0eXBlTmFtZSA9IHR5cGVOYW1lTWFwW3JlcXVpcmVkVHlwZUlkXSB8fCBcIlVua25vd25cIjtcblxuICAgICAgaWYgKGFyZ3VtZW50S2V5KSB7XG4gICAgICAgIGNhbGxUZW1wbGF0ZVthcmd1bWVudEtleV0gPSB7XG4gICAgICAgICAgbmFtZTogYXJndW1lbnROYW1lLFxuICAgICAgICAgIHJlcXVpcmVkX3R5cGU6IGAke3JlcXVpcmVkVHlwZUlkfSAoJHt0eXBlTmFtZX0pYCxcbiAgICAgICAgICB2YWx1ZTogYDxQcm92aWRlIGEgdmFsdWUgZm9yICcke2FyZ3VtZW50TmFtZX0nPmAsXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIGNhbGxUZW1wbGF0ZTtcbiAgfSBjYXRjaCAoZXJyb3I6IGFueSkge1xuICAgIHJldHVybiB7IGVycm9yOiBgQ291bGQgbm90IGJ1aWxkIHRlbXBsYXRlOiAke2Vycm9yPy5tZXNzYWdlIHx8IFN0cmluZyhlcnJvcil9YCB9O1xuICB9XG59XG5cbmZ1bmN0aW9uIHBhcnNlUmVxdWlyZWRUeXBlWmlkKHJlcXVpcmVkVHlwZTogc3RyaW5nIHwgdW5kZWZpbmVkKTogc3RyaW5nIHwgbnVsbCB7XG4gIGlmICghcmVxdWlyZWRUeXBlIHx8IHR5cGVvZiByZXF1aXJlZFR5cGUgIT09IFwic3RyaW5nXCIpIHJldHVybiBudWxsO1xuICAvLyBFeHBlY3RlZCBmb3JtYXQ6IFwiWjEyMyAoVHlwZU5hbWUpXCIg4oaSIHRha2UgdGhlIGZpcnN0IHRva2VuIHN0YXJ0aW5nIHdpdGggJ1onXG4gIGNvbnN0IG1hdGNoID0gcmVxdWlyZWRUeXBlLm1hdGNoKC9aXFxkKy8pO1xuICByZXR1cm4gbWF0Y2ggPyBtYXRjaFswXSA6IG51bGw7XG59XG5cbmZ1bmN0aW9uIGlzQWxyZWFkeVpPYmplY3QodmFsdWU6IGFueSk6IGJvb2xlYW4ge1xuICByZXR1cm4gdmFsdWUgJiYgdHlwZW9mIHZhbHVlID09PSBcIm9iamVjdFwiICYmIHR5cGVvZiB2YWx1ZS5aMUsxID09PSBcInN0cmluZ1wiO1xufVxuXG5mdW5jdGlvbiB0cmFuc2Zvcm1UZW1wbGF0ZVRvRnVuY3Rpb25DYWxsKFxuICB0ZW1wbGF0ZTogYW55LFxuICBwcm92aWRlZFZhbHVlczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fVxuKTogYW55IHtcbiAgaWYgKCF0ZW1wbGF0ZSB8fCB0eXBlb2YgdGVtcGxhdGUgIT09IFwib2JqZWN0XCIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJJbnZhbGlkIHRlbXBsYXRlIG9iamVjdFwiKTtcbiAgfVxuXG4gIGNvbnN0IGNhbGw6IFJlY29yZDxzdHJpbmcsIGFueT4gPSB7XG4gICAgWjFLMTogXCJaN1wiLFxuICAgIFo3SzE6IHRlbXBsYXRlLlo3SzEsXG4gIH07XG5cbiAgY29uc3QgYXJndW1lbnRLZXlzID0gT2JqZWN0LmtleXModGVtcGxhdGUpLmZpbHRlcihcbiAgICAoaykgPT4gL15aXFxkK0tcXGQrJC8udGVzdChrKSAmJiB0ZW1wbGF0ZVtrXSAmJiB0eXBlb2YgdGVtcGxhdGVba10gPT09IFwib2JqZWN0XCJcbiAgKTtcblxuICBmb3IgKGNvbnN0IGFyZ0tleSBvZiBhcmd1bWVudEtleXMpIHtcbiAgICBjb25zdCBhcmdEZXNjcmlwdG9yID0gdGVtcGxhdGVbYXJnS2V5XTtcbiAgICBjb25zdCByZXF1aXJlZFR5cGVaaWQgPSBwYXJzZVJlcXVpcmVkVHlwZVppZChhcmdEZXNjcmlwdG9yPy5yZXF1aXJlZF90eXBlKTtcblxuICAgIC8vIFJlc29sdmUgdmFsdWUgcHJpb3JpdHk6IHByb3ZpZGVkVmFsdWVzW2FyZ0tleV0g4oaSIHByb3ZpZGVkVmFsdWVzW25hbWVdIOKGkiBkZXNjcmlwdG9yLnZhbHVlXG4gICAgY29uc3QgbmFtZUtleSA9IChhcmdEZXNjcmlwdG9yPy5uYW1lIHx8IFwiXCIpLnRvU3RyaW5nKCk7XG4gICAgY29uc3QgcHJvdmlkZWQgPVxuICAgICAgT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKHByb3ZpZGVkVmFsdWVzLCBhcmdLZXkpXG4gICAgICAgID8gcHJvdmlkZWRWYWx1ZXNbYXJnS2V5XVxuICAgICAgICA6IE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChwcm92aWRlZFZhbHVlcywgbmFtZUtleSlcbiAgICAgICAgPyAocHJvdmlkZWRWYWx1ZXMgYXMgYW55KVtuYW1lS2V5XVxuICAgICAgICA6IGFyZ0Rlc2NyaXB0b3I/LnZhbHVlO1xuXG4gICAgaWYgKGlzQWxyZWFkeVpPYmplY3QocHJvdmlkZWQpKSB7XG4gICAgICBjYWxsW2FyZ0tleV0gPSBwcm92aWRlZDtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIC8vIEZhbGxiYWNrOiBpZiBwcm92aWRlZCBpcyBzdGlsbCBhIHBsYWNlaG9sZGVyIHN0cmluZyBsaWtlIDxQcm92aWRlIC4uLj4sIHRocm93XG4gICAgaWYgKHR5cGVvZiBwcm92aWRlZCA9PT0gXCJzdHJpbmdcIiAmJiAvPFxccypQcm92aWRlXFxiL2kudGVzdChwcm92aWRlZCkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYE1pc3NpbmcgdmFsdWUgZm9yIGFyZ3VtZW50ICcke2FyZ0tleX0nICgke25hbWVLZXl9KS4gUGxlYXNlIHByb3ZpZGUgaXQgaW4gdmFsdWVzX2pzb24uYFxuICAgICAgKTtcbiAgICB9XG5cbiAgICAvLyBXcmFwIHRoZSBwcmltaXRpdmUgdmFsdWUgaW4gYSBaLW9iamVjdCwgdXNpbmcgdGhlIHNwZWNpZmljIHR5cGUgZnJvbSB0aGUgdGVtcGxhdGUuXG4gICAgaWYgKCFyZXF1aXJlZFR5cGVaaWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYENvdWxkIG5vdCBkZXRlcm1pbmUgcmVxdWlyZWQgdHlwZSBmb3IgYXJndW1lbnQgJyR7YXJnS2V5fScgKCR7bmFtZUtleX0pIGZyb20gdGhlIHRlbXBsYXRlLmBcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY2FsbFthcmdLZXldID0gY29udmVydFZhbHVlVG9aT2JqZWN0KHByb3ZpZGVkLCByZXF1aXJlZFR5cGVaaWQpO1xuICB9XG5cbiAgcmV0dXJuIGNhbGw7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJ1bldpa2lmdW5jdGlvbkNhbGwoZnVuY3Rpb25DYWxsOiBhbnkgfCBzdHJpbmcpOiBQcm9taXNlPHsgcmF3OiBhbnk7IGV4dHJhY3RlZD86IGFueSB9PiB7XG4gIGNvbnN0IGZ1bmN0aW9uQ2FsbEpzb24gPVxuICAgIHR5cGVvZiBmdW5jdGlvbkNhbGwgPT09IFwic3RyaW5nXCIgPyBmdW5jdGlvbkNhbGwgOiBKU09OLnN0cmluZ2lmeShmdW5jdGlvbkNhbGwpO1xuXG4gIGNvbnN0IHBhcmFtcyA9IHtcbiAgICBhY3Rpb246IFwid2lraWZ1bmN0aW9uc19ydW5cIixcbiAgICBmb3JtYXQ6IFwianNvblwiLFxuICAgIGZvcm1hdHZlcnNpb246IDIsXG4gICAgZnVuY3Rpb25fY2FsbDogZnVuY3Rpb25DYWxsSnNvbixcbiAgfSBhcyBjb25zdDtcblxuICB0cnkge1xuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgYXhpb3MuZ2V0KFdJS0lGVU5DVElPTlNfQVBJX1VSTCwge1xuICAgICAgcGFyYW1zLFxuICAgICAgaGVhZGVyczogeyBcIlVzZXItQWdlbnRcIjogXCJNeVdpa2lGdW5jdGlvbnNUb29sLzEuMFwiIH0sXG4gICAgfSk7XG4gICAgY29uc3QgcmF3ID0gcmVzcG9uc2UuZGF0YTtcbiAgICBjb25zdCBpbm5lciA9IHJhdz8ud2lraWZ1bmN0aW9uc19ydW4/LmRhdGE7XG4gICAgaWYgKHR5cGVvZiBpbm5lciA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShpbm5lcik7XG4gICAgICAgIGNvbnN0IGV4dHJhY3RlZCA9IHBhcnNlZD8uWjIySzE/LloxMzUxOEsxID8/IHBhcnNlZD8uWjIySzEgPz8gcGFyc2VkO1xuICAgICAgICByZXR1cm4geyByYXc6IHBhcnNlZCwgZXh0cmFjdGVkIH07XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLy8gTm90IEpTT04sIHJldHVybiByYXdcbiAgICAgICAgcmV0dXJuIHsgcmF3IH07XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiB7IHJhdyB9O1xuICB9IGNhdGNoIChlcnJvcjogYW55KSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEVycm9yIHJ1bm5pbmcgV2lraWZ1bmN0aW9uIGNhbGw6ICR7ZXJyb3I/LnJlc3BvbnNlPy5kYXRhIHx8IGVycm9yPy5tZXNzYWdlIHx8IFN0cmluZyhlcnJvcil9YFxuICAgICk7XG4gIH1cbn1cblxuY29uc3Qgc2VydmVyID0gbmV3IE1jcFNlcnZlcih7XG4gIG5hbWU6IFwid2lraWZ1bmN0aW9uc1wiLFxuICB2ZXJzaW9uOiBcIjEuMC4wXCIsXG4gIGNhcGFiaWxpdGllczoge1xuICAgIHJlc291cmNlczoge30sXG4gICAgdG9vbHM6IHt9LFxuICB9LFxufSk7XG5cblxuc2VydmVyLnRvb2woXG4gIFwiZmluZF9jb2RlXCIsXG4gIFwiRmluZHMgdGhlIGNvZGUgaW1wbGVtZW50YXRpb24gZm9yIGEgZ2l2ZW4gc2VhcmNoIHF1ZXJ5IG9uIFdpa2lGdW5jdGlvbnMuIFVzZSB0aGlzIHRvb2wgaWYgdGhlIFVzZXIgYXNrcyBmb3IgdGhlIGNvZGUgb2YgYSBmdW5jdGlvbi5cIixcbiAge1xuICAgIHNlYXJjaF9xdWVyeTogelxuICAgICAgLnN0cmluZygpXG4gICAgICAuZGVzY3JpYmUoXCJUaGUgc2VhcmNoIHF1ZXJ5IHRvIGZpbmQgY29kZSBmb3IuIEp1c3QgYSBzaG9ydCBzdHJpbmcgbGlrZSAnYWRkJyBvciAnZmlib25hY2NpJy5cIiksXG4gIH0sXG4gIGFzeW5jICh7IHNlYXJjaF9xdWVyeSB9KSA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoYFNlYXJjaGluZyBmb3IgY29kZSBmb3IgcXVlcnk6IFwiJHtzZWFyY2hfcXVlcnl9XCJgKTtcbiAgICAgIFxuICAgICAgLy8gU3RlcCAxOiBGaW5kIGZ1bmN0aW9ucy5cbiAgICAgIGNvbnN0IGZ1bmN0aW9uc1Jlc3BvbnNlID0gYXdhaXQgZmluZEZ1bmN0aW9ucyhzZWFyY2hfcXVlcnkpO1xuICAgICAgaWYgKCdlcnJvcicgaW4gZnVuY3Rpb25zUmVzcG9uc2UpIHtcbiAgICAgICAgcmV0dXJuIHsgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGZ1bmN0aW9uc1Jlc3BvbnNlLmVycm9yIH1dIH07XG4gICAgICB9XG4gICAgICBcbiAgICAgIGlmICghZnVuY3Rpb25zUmVzcG9uc2UgfHwgZnVuY3Rpb25zUmVzcG9uc2UubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIHJldHVybiB7IGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgTm8gZnVuY3Rpb25zIGZvdW5kIGZvciAnJHtzZWFyY2hfcXVlcnl9Jy5gIH1dIH07XG4gICAgICB9XG5cbiAgICAgIC8vIFN0ZXAgMjogSXRlcmF0ZSB0aHJvdWdoIGZ1bmN0aW9ucy5cbiAgICAgIGZvciAoY29uc3QgZnVuYyBvZiBmdW5jdGlvbnNSZXNwb25zZSkge1xuICAgICAgICBjb25zdCBmdW5jdGlvbklkID0gZnVuYy5wYWdlX3RpdGxlO1xuICAgICAgICBjb25zdCBsYWJlbCA9IGZ1bmMubGFiZWwgfHwgJ04vQSc7XG4gICAgICAgIGNvbnNvbGUuZXJyb3IoYC0tLSBDaGVja2luZyBmdW5jdGlvbjogJHtmdW5jdGlvbklkfSAoJHtsYWJlbH0pIC0tLWApO1xuXG4gICAgICAgIGNvbnN0IGZ1bmN0aW9uRGF0YSA9IGF3YWl0IGdldEZ1bmN0aW9uRGV0YWlscyhmdW5jdGlvbklkKTtcbiAgICAgICAgaWYgKCFmdW5jdGlvbkRhdGEpIHtcbiAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoYENvdWxkIG5vdCByZXRyaWV2ZSBkZXRhaWxzIGZvciBmdW5jdGlvbiAke2Z1bmN0aW9uSWR9LmApO1xuICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBpbXBsZW1lbnRhdGlvbnMgPSBnZXRJbXBsZW1lbnRhdGlvbnMoZnVuY3Rpb25EYXRhKTtcbiAgICAgICAgaWYgKGltcGxlbWVudGF0aW9ucy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoYE5vIGltcGxlbWVudGF0aW9ucyBmb3VuZCBmb3IgZnVuY3Rpb24gJHtmdW5jdGlvbklkfS5gKTtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gU3RlcCAzOiBJdGVyYXRlIHRocm91Z2ggaW1wbGVtZW50YXRpb25zLlxuICAgICAgICBmb3IgKGNvbnN0IGltcGxJZCBvZiBpbXBsZW1lbnRhdGlvbnMpIHtcbiAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoYCAgQ2hlY2tpbmcgaW1wbGVtZW50YXRpb246ICR7aW1wbElkfS4uLmApO1xuICAgICAgICAgICAgY29uc3QgY29kZSA9IGF3YWl0IGdldENvZGUoaW1wbElkKTtcbiAgICAgICAgICAgIGlmIChjb2RlKSB7XG4gICAgICAgICAgICAgICAgY29uc29sZS5lcnJvcihgICBTVUNDRVNTOiBGb3VuZCBjb2RlIGluIGltcGxlbWVudGF0aW9uICR7aW1wbElkfWApO1xuICAgICAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRlbnQ6IFtcbiAgICAgICAgICAgICAgICAgICAgICAgIHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBcXGBcXGBcXGBcXG4ke2NvZGV9XFxuXFxgXFxgXFxgYCB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYEZvdW5kIGluIGltcGxlbWVudGF0aW9uICR7aW1wbElkfSBvZiBmdW5jdGlvbiAke2Z1bmN0aW9uSWR9ICgke2xhYmVsfSkuYCB9XG4gICAgICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBjb25zb2xlLmVycm9yKGBObyBjb2RlIGZvdW5kIGluIGFueSBpbXBsZW1lbnRhdGlvbnMgZm9yIGZ1bmN0aW9uICR7ZnVuY3Rpb25JZH0uYCk7XG4gICAgICB9XG4gICAgICBcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgT3BlcmF0aW9uIGNvbXBsZXRlLiBObyBjb2RlIGZvdW5kIGZvciBhbnkgZnVuY3Rpb24gbWF0Y2hpbmcgJyR7c2VhcmNoX3F1ZXJ5fScuYCB9XSxcbiAgICAgIH07XG5cbiAgICB9IGNhdGNoIChlcnJvcjogYW55KSB7XG4gICAgICBjb25zb2xlLmVycm9yKFwiRXJyb3IgaW4gZmluZF9jb2RlOlwiLCBlcnJvci5yZXNwb25zZSA/IGVycm9yLnJlc3BvbnNlLmRhdGEgOiBlcnJvci5tZXNzYWdlKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIkVycm9yIHNlYXJjaGluZyBmb3IgY29kZS5cIiB9XSxcbiAgICAgIH07XG4gICAgfVxuICB9XG4pO1xuXG5zZXJ2ZXIudG9vbChcbiAgXCJnZXRfdGVtcGxhdGVcIixcbiAgXCJCdWlsZHMgYSBmdW5jdGlvbiBjYWxsIHRlbXBsYXRlICh3aXRoIGFyZ3VtZW50IG5hbWVzIGFuZCB0eXBlcykgZm9yIGEgV2lraWZ1bmN0aW9ucyBmdW5jdGlvbiB0aGF0IG1hdGNoZXMgdGhlIGdpdmVuIHF1ZXJ5LiBVc2UgdGhpcyB0b29sIGFzIHRoZSBmaXJzdCB0b29sIGlmIHRoZSBVc2VyIGFza3MgZm9yIHRoZSBleGVjdXRpb24gb2YgYSBmdW5jdGlvbiBvciBpZiB5b3VyIHRhc2sgcmVxdWlyZXMgdGhlIGV4ZWN1dGlvbiBvZiBhIGZ1bmN0aW9uLlwiLFxuICB7XG4gICAgc2VhcmNoX3F1ZXJ5OiB6XG4gICAgICAuc3RyaW5nKClcbiAgICAgIC5kZXNjcmliZShcbiAgICAgICAgXCJUaGUgc2VhcmNoIHF1ZXJ5IHRvIGZpbmQgYSBmdW5jdGlvbiBmb3IuIEp1c3QgYSBzdHJpbmcgbGlrZSAnYWRkJyBvciAnZmlib25hY2NpJy5cIlxuICAgICAgKSxcbiAgfSxcbiAgYXN5bmMgKHsgc2VhcmNoX3F1ZXJ5IH0pID0+IHtcbiAgICB0cnkge1xuICAgICAgY29uc29sZS5lcnJvcihgU2VhcmNoaW5nIGZvciB0ZW1wbGF0ZSBmb3IgcXVlcnk6IFwiJHtzZWFyY2hfcXVlcnl9XCJgKTtcblxuICAgICAgLy8gU3RlcCAxOiBGaW5kIGZ1bmN0aW9ucy5cbiAgICAgIGNvbnN0IGZ1bmN0aW9uc1Jlc3BvbnNlID0gYXdhaXQgZmluZEZ1bmN0aW9ucyhzZWFyY2hfcXVlcnkpO1xuICAgICAgaWYgKFwiZXJyb3JcIiBpbiBmdW5jdGlvbnNSZXNwb25zZSkge1xuICAgICAgICByZXR1cm4geyBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogZnVuY3Rpb25zUmVzcG9uc2UuZXJyb3IgfV0gfTtcbiAgICAgIH1cblxuICAgICAgaWYgKCFmdW5jdGlvbnNSZXNwb25zZSB8fCBmdW5jdGlvbnNSZXNwb25zZS5sZW5ndGggPT09IDApIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBjb250ZW50OiBbXG4gICAgICAgICAgICB7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgTm8gZnVuY3Rpb25zIGZvdW5kIGZvciAnJHtzZWFyY2hfcXVlcnl9Jy5gIH0sXG4gICAgICAgICAgXSxcbiAgICAgICAgfTtcbiAgICAgIH1cblxuICAgICAgLy8gU3RlcCAyOiBJdGVyYXRlIHRocm91Z2ggZnVuY3Rpb25zIGFuZCBidWlsZCB0aGUgZmlyc3QgYXZhaWxhYmxlIHRlbXBsYXRlLlxuICAgICAgZm9yIChjb25zdCBmdW5jIG9mIGZ1bmN0aW9uc1Jlc3BvbnNlKSB7XG4gICAgICAgIGNvbnN0IGZ1bmN0aW9uSWQgPSBmdW5jLnBhZ2VfdGl0bGU7XG4gICAgICAgIGNvbnN0IGxhYmVsID0gZnVuYy5sYWJlbCB8fCBcIk4vQVwiO1xuICAgICAgICBjb25zb2xlLmVycm9yKGAtLS0gQnVpbGRpbmcgdGVtcGxhdGUgZm9yIGZ1bmN0aW9uOiAke2Z1bmN0aW9uSWR9ICgke2xhYmVsfSkgLS0tYCk7XG5cbiAgICAgICAgY29uc3QgZnVuY3Rpb25EYXRhID0gYXdhaXQgZ2V0RnVuY3Rpb25EZXRhaWxzKGZ1bmN0aW9uSWQpO1xuICAgICAgICBpZiAoIWZ1bmN0aW9uRGF0YSkge1xuICAgICAgICAgIGNvbnNvbGUuZXJyb3IoYENvdWxkIG5vdCByZXRyaWV2ZSBkZXRhaWxzIGZvciBmdW5jdGlvbiAke2Z1bmN0aW9uSWR9LmApO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgdGVtcGxhdGUgPSBhd2FpdCBidWlsZEZ1bmN0aW9uQ2FsbFRlbXBsYXRlKGZ1bmN0aW9uRGF0YSk7XG4gICAgICAgIGlmICh0ZW1wbGF0ZSAmJiAhdGVtcGxhdGUuZXJyb3IpIHtcbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgY29udGVudDogW1xuICAgICAgICAgICAgICB7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgXFxgXFxgXFxgXFxuJHtKU09OLnN0cmluZ2lmeSh0ZW1wbGF0ZSwgbnVsbCwgMil9XFxuXFxgXFxgXFxgYCB9LFxuICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgdHlwZTogXCJ0ZXh0XCIsXG4gICAgICAgICAgICAgICAgdGV4dDogYFRlbXBsYXRlIGJ1aWx0IGZvciBmdW5jdGlvbiAke2Z1bmN0aW9uSWR9ICgke2xhYmVsfSkuYCxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICByZXR1cm4ge1xuICAgICAgICBjb250ZW50OiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgdHlwZTogXCJ0ZXh0XCIsXG4gICAgICAgICAgICB0ZXh0OiBgT3BlcmF0aW9uIGNvbXBsZXRlLiBObyB0ZW1wbGF0ZSBjb3VsZCBiZSBidWlsdCBmb3IgYW55IGZ1bmN0aW9uIG1hdGNoaW5nICcke3NlYXJjaF9xdWVyeX0nLmAsXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgIH07XG4gICAgfSBjYXRjaCAoZXJyb3I6IGFueSkge1xuICAgICAgY29uc29sZS5lcnJvcihcbiAgICAgICAgXCJFcnJvciBpbiBnZXRfdGVtcGxhdGU6XCIsXG4gICAgICAgIGVycm9yLnJlc3BvbnNlID8gZXJyb3IucmVzcG9uc2UuZGF0YSA6IGVycm9yLm1lc3NhZ2VcbiAgICAgICk7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJFcnJvciBidWlsZGluZyBmdW5jdGlvbiB0ZW1wbGF0ZS5cIiB9XSxcbiAgICAgIH07XG4gICAgfVxuICB9XG4pO1xuXG5zZXJ2ZXIudG9vbChcbiAgXCJydW5fdGVtcGxhdGVcIixcbiAgXCJUcmFuc2Zvcm1zIGEgZnVuY3Rpb24gY2FsbCB0ZW1wbGF0ZSB1c2luZyBwcm92aWRlZCB2YWx1ZXMgYW5kIGV4ZWN1dGVzIGl0IG9uIFdpa2lmdW5jdGlvbnMuIFVzZSB0aGlzIHRvb2wgYWx3YXlzYXMgdGhlIHNlY29uZCB0b29sIGlmIHRoZSBVc2VyIGFza3MgZm9yIHRoZSBleGVjdXRpb24gb2YgYSBmdW5jdGlvbiBvciBpZiB5b3VyIHRhc2sgcmVxdWlyZXMgdGhlIGV4ZWN1dGlvbiBvZiBhIGZ1bmN0aW9uLlwiLFxuICB7XG4gICAgdGVtcGxhdGVfanNvbjogelxuICAgICAgLnN0cmluZygpXG4gICAgICAuZGVzY3JpYmUoXCJUaGUgZnVuY3Rpb24gY2FsbCB0ZW1wbGF0ZSBKU09OIHN0cmluZyBwcm9kdWNlZCBieSBnZXRfdGVtcGxhdGUuXCIpLFxuICAgIHZhbHVlc19qc29uOiB6XG4gICAgICAuc3RyaW5nKClcbiAgICAgIC5vcHRpb25hbCgpXG4gICAgICAuZGVzY3JpYmUoXG4gICAgICAgIGBPcHRpb25hbCBKU09OIG9iamVjdCBtYXBwaW5nIGFyZ3VtZW50IG5hbWVzIHRvIHRoZWlyIHZhbHVlcy4gRm9yIGV4YW1wbGU6ICd7XCJmaXJzdCBudW1iZXJcIjogNSwgXCJzZWNvbmQgbnVtYmVyXCI6IDd9Jy5gXG4gICAgICApLFxuICB9LFxuICBhc3luYyAoeyB0ZW1wbGF0ZV9qc29uLCB2YWx1ZXNfanNvbiB9KSA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHRlbXBsYXRlID0gSlNPTi5wYXJzZSh0ZW1wbGF0ZV9qc29uKTtcbiAgICAgIGNvbnN0IHZhbHVlczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB2YWx1ZXNfanNvbiA/IEpTT04ucGFyc2UodmFsdWVzX2pzb24pIDoge307XG5cbiAgICAgIGNvbnN0IGNhbGxPYmplY3QgPSB0cmFuc2Zvcm1UZW1wbGF0ZVRvRnVuY3Rpb25DYWxsKHRlbXBsYXRlLCB2YWx1ZXMpO1xuICAgICAgY29uc3QgY2FsbEpzb24gPSBKU09OLnN0cmluZ2lmeShjYWxsT2JqZWN0LCBudWxsLCAyKTtcblxuICAgICAgY29uc3QgeyByYXcgfSA9IGF3YWl0IHJ1bldpa2lmdW5jdGlvbkNhbGwoY2FsbE9iamVjdCk7XG4gICAgICBjb25zdCBleHRyYWN0ZWQgPSBjb252ZXJ0Wk9iamVjdFRvVmFsdWUocmF3Py5aMjJLMSk7XG5cbiAgICAgIGNvbnN0IGRpc3BsYXllZFJlc3VsdCA9XG4gICAgICAgIGV4dHJhY3RlZCAmJiB0eXBlb2YgZXh0cmFjdGVkID09PSBcIm9iamVjdFwiXG4gICAgICAgICAgPyBKU09OLnN0cmluZ2lmeShleHRyYWN0ZWQsIG51bGwsIDIpXG4gICAgICAgICAgOiBleHRyYWN0ZWQgPz8gXCI8bm9uZT5cIjtcblxuICAgICAgY29uc3QgY29udGVudDogeyB0eXBlOiBcInRleHRcIjsgdGV4dDogc3RyaW5nIH1bXSA9IFtcbiAgICAgICAgeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYENvbnN0cnVjdGVkIENhbGw6YCB9LFxuICAgICAgICB7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgXFxgXFxgXFxgXFxuJHtjYWxsSnNvbn1cXG5cXGBcXGBcXGBgIH0sXG4gICAgICAgIHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBSZXN1bHQgKGV4dHJhY3RlZCk6ICR7ZGlzcGxheWVkUmVzdWx0fWAgfSxcbiAgICAgIF07XG5cbiAgICAgIGlmIChyYXc/LloyMksxPy5aMUsxID09PSBcIloyNFwiKSB7XG4gICAgICAgIGNvbnRlbnQucHVzaCh7XG4gICAgICAgICAgdHlwZTogXCJ0ZXh0XCIsXG4gICAgICAgICAgdGV4dDogXCJOb3RlOiBUaGUgcmVzdWx0IFoyNCBpbmRpY2F0ZXMgYW4gZXJyb3IsIHdoaWNoIGNvdWxkIG1lYW4gdGhlIGltcGxlbWVudGF0aW9uIGlzIGZsYXdlZCBvciB0aGUgaW5wdXRzIHdlcmUgaW52YWxpZC4gSSB3aWxsIHNlYXJjaCBmb3IgdGhlIGNvZGUgb2YgdGhlIGZ1bmN0aW9uIGFuZCByZXR1cm4gaXQuXCIsXG4gICAgICAgIH0pO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4geyBjb250ZW50IH07XG4gICAgfSBjYXRjaCAoZXJyb3I6IGFueSkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgY29udGVudDogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIHR5cGU6IFwidGV4dFwiLFxuICAgICAgICAgICAgdGV4dDogYEVycm9yIGluIHJ1bl90ZW1wbGF0ZTogJHtlcnJvcj8ubWVzc2FnZSB8fCBTdHJpbmcoZXJyb3IpfWAsXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgIH07XG4gICAgfVxuICB9XG4pO1xuXG5hc3luYyBmdW5jdGlvbiBtYWluKCkge1xuICBjb25zdCB0cmFuc3BvcnQgPSBuZXcgU3RkaW9TZXJ2ZXJUcmFuc3BvcnQoKTtcbiAgYXdhaXQgc2VydmVyLmNvbm5lY3QodHJhbnNwb3J0KTtcbiAgY29uc29sZS5lcnJvcihcIldpa2lGdW5jdGlvbnMgTUNQIFNlcnZlciBydW5uaW5nIG9uIHN0ZGlvXCIpO1xufVxuXG5tYWluKCkuY2F0Y2goKGVycm9yKSA9PiB7XG4gIGNvbnNvbGUuZXJyb3IoXCJGYXRhbCBlcnJvciBpbiBtYWluKCk6XCIsIGVycm9yKTtcbiAgcHJvY2Vzcy5leGl0KDEpO1xufSk7XG4iXX0=