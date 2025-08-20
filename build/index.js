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
server.tool("find_code", "Finds the first available code implementation for a given search query on WikiFunctions.", {
    search_query: z
        .string()
        .describe("The search query to find code for. Just a string like 'add' or 'fibonacci'."),
}, async ({ search_query }) => {
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
    }
    catch (error) {
        console.error("Error in find_code:", error.response ? error.response.data : error.message);
        return {
            content: [{ type: "text", text: "Error searching for code." }],
        };
    }
});
server.tool("get_template", "Builds a function call template (with argument names and types) for a Wikifunctions function that matches the given query.", {
    search_query: z
        .string()
        .describe("The search query to find a function for. Just a string like 'add' or 'fibonacci'."),
}, async ({ search_query }) => {
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
    }
    catch (error) {
        console.error("Error in get_template:", error.response ? error.response.data : error.message);
        return {
            content: [{ type: "text", text: "Error building function template." }],
        };
    }
});
server.tool("run_template", "Transforms a function call template using provided values and executes it on Wikifunctions.", {
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUFFLFNBQVMsRUFBRSxNQUFNLHlDQUF5QyxDQUFDO0FBQ3BFLE9BQU8sRUFBRSxvQkFBb0IsRUFBRSxNQUFNLDJDQUEyQyxDQUFDO0FBQ2pGLE9BQU8sRUFBRSxDQUFDLEVBQUUsTUFBTSxLQUFLLENBQUM7QUFDeEIsT0FBTyxLQUFLLE1BQU0sT0FBTyxDQUFDO0FBQzFCLE9BQU8sRUFDTCxxQkFBcUIsRUFDckIscUJBQXFCLEdBQ3RCLE1BQU0scUJBQXFCLENBQUM7QUFFN0IsTUFBTSxxQkFBcUIsR0FBRyx5Q0FBeUMsQ0FBQztBQUV4RSwyQkFBMkI7QUFFM0IsS0FBSyxVQUFVLGFBQWEsQ0FBQyxXQUFtQjtJQUM5QyxNQUFNLE1BQU0sR0FBRztRQUNiLE1BQU0sRUFBRSxPQUFPO1FBQ2YsTUFBTSxFQUFFLE1BQU07UUFDZCxJQUFJLEVBQUUsNEJBQTRCO1FBQ2xDLGlDQUFpQyxFQUFFLFdBQVc7UUFDOUMsbUNBQW1DLEVBQUUsSUFBSTtRQUN6QyxnQ0FBZ0MsRUFBRSxFQUFFO0tBQ3JDLENBQUM7SUFDRixNQUFNLE9BQU8sR0FBRyxFQUFFLFlBQVksRUFBRSx5QkFBeUIsRUFBRSxDQUFDO0lBRTVELElBQUksQ0FBQztRQUNILE1BQU0sUUFBUSxHQUFHLE1BQU0sS0FBSyxDQUFDLEdBQUcsQ0FBQyxxQkFBcUIsRUFBRSxFQUFFLE1BQU0sRUFBRSxPQUFPLEVBQUUsQ0FBQyxDQUFDO1FBQzdFLE9BQU8sUUFBUSxDQUFDLElBQUksRUFBRSxLQUFLLEVBQUUsMEJBQTBCLElBQUksRUFBRSxDQUFDO0lBQ2hFLENBQUM7SUFBQyxPQUFPLENBQU0sRUFBRSxDQUFDO1FBQ2hCLE1BQU0sS0FBSyxHQUFHLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFD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QU8sRUFBRTtnQkFDUDtvQkFDRSxJQUFJLEVBQUUsTUFBTTtvQkFDWixJQUFJLEVBQUUsMEJBQTBCLEtBQUssRUFBRSxPQUFPLElBQUksTUFBTSxDQUFDLEtBQUssQ0FBQyxFQUFFO2lCQUNsRTthQUNGO1NBQ0YsQ0FBQztJQUNKLENBQUM7QUFDSCxDQUFDLENBQ0YsQ0FBQztBQUVGLEtBQUssVUFBVSxJQUFJO0lBQ2pCLE1BQU0sU0FBUyxHQUFHLElBQUksb0JBQW9CLEVBQUUsQ0FBQztJQUM3QyxNQUFNLE1BQU0sQ0FBQyxPQUFPLENBQUMsU0FBUyxDQUFDLENBQUM7SUFDaEMsT0FBTyxDQUFDLEtBQUssQ0FBQywyQ0FBMkMsQ0FBQyxDQUFDO0FBQzdELENBQUM7QUFFRCxJQUFJLEVBQUUsQ0FBQyxLQUFLLENBQUMsQ0FBQyxLQUFLLEVBQUUsRUFBRTtJQUNyQixPQUFPLENBQUMsS0FBSyxDQUFDLHdCQUF3QixFQUFFLEtBQUssQ0FBQyxDQUFDO0lBQy9DLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDbEIsQ0FBQyxDQUFDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBNY3BTZXJ2ZXIgfSBmcm9tIFwiQG1vZGVsY29udGV4dHByb3RvY29sL3Nkay9zZXJ2ZXIvbWNwLmpzXCI7XG5pbXBvcnQgeyBTdGRpb1NlcnZlclRyYW5zcG9ydCB9IGZyb20gXCJAbW9kZWxjb250ZXh0cHJvdG9jb2wvc2RrL3NlcnZlci9zdGRpby5qc1wiO1xuaW1wb3J0IHsgeiB9IGZyb20gXCJ6b2RcIjtcbmltcG9ydCBheGlvcyBmcm9tIFwiYXhpb3NcIjtcbmltcG9ydCB7XG4gIGNvbnZlcnRWYWx1ZVRvWk9iamVjdCxcbiAgY29udmVydFpPYmplY3RUb1ZhbHVlLFxufSBmcm9tIFwiLi90eXBlLWNvbnZlcnRlci5qc1wiO1xuXG5jb25zdCBXSUtJRlVOQ1RJT05TX0FQSV9VUkwgPSBcImh0dHBzOi8vd3d3Lndpa2lmdW5jdGlvbnMub3JnL3cvYXBpLnBocFwiO1xuXG4vLyAtLS0gSGVscGVyIEZ1bmN0aW9ucyAtLS1cblxuYXN5bmMgZnVuY3Rpb24gZmluZEZ1bmN0aW9ucyhzZWFyY2hRdWVyeTogc3RyaW5nKTogUHJvbWlzZTxhbnlbXSB8IHsgZXJyb3I6IHN0cmluZyB9PiB7XG4gIGNvbnN0IHBhcmFtcyA9IHtcbiAgICBhY3Rpb246IFwicXVlcnlcIixcbiAgICBmb3JtYXQ6IFwianNvblwiLFxuICAgIGxpc3Q6IFwid2lraWxhbWJkYXNlYXJjaF9mdW5jdGlvbnNcIixcbiAgICB3aWtpbGFtYmRhc2VhcmNoX2Z1bmN0aW9uc19zZWFyY2g6IHNlYXJjaFF1ZXJ5LFxuICAgIHdpa2lsYW1iZGFzZWFyY2hfZnVuY3Rpb25zX2xhbmd1YWdlOiBcImVuXCIsXG4gICAgd2lraWxhbWJkYXNlYXJjaF9mdW5jdGlvbnNfbGltaXQ6IDEwLFxuICB9O1xuICBjb25zdCBoZWFkZXJzID0geyBcIlVzZXItQWdlbnRcIjogXCJNeVdpa2lGdW5jdGlvbnNUb29sLzEuMFwiIH07XG5cbiAgdHJ5IHtcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGF4aW9zLmdldChXSUtJRlVOQ1RJT05TX0FQSV9VUkwsIHsgcGFyYW1zLCBoZWFkZXJzIH0pO1xuICAgIHJldHVybiByZXNwb25zZS5kYXRhPy5xdWVyeT8ud2lraWxhbWJkYXNlYXJjaF9mdW5jdGlvbnMgfHwgW107XG4gIH0gY2F0Y2ggKGU6IGFueSkge1xuICAgIGNvbnN0IGVycm9yID0gZS5yZXNwb25zZSA/IGUucmVzcG9uc2UuZGF0YSA6IGUubWVzc2FnZTtcbiAgICBjb25zb2xlLmVycm9yKGBFcnJvciBzZWFyY2hpbmcgZm9yIGZ1bmN0aW9uczogJHtlcnJvcn1gKTtcbiAgICByZXR1cm4geyBlcnJvcjogYEVycm9yIHNlYXJjaGluZyBmb3IgZnVuY3Rpb25zOiAke2Vycm9yfWAgfTtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBnZXRGdW5jdGlvbkRldGFpbHMoZnVuY3Rpb25JZDogc3RyaW5nKTogUHJvbWlzZTxhbnkgfCBudWxsPiB7XG4gIGNvbnN0IHBhcmFtcyA9IHtcbiAgICBhY3Rpb246IFwid2lraWxhbWJkYV9mZXRjaFwiLFxuICAgIGZvcm1hdDogXCJqc29uXCIsXG4gICAgemlkczogZnVuY3Rpb25JZCxcbiAgfTtcblxuICB0cnkge1xuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgYXhpb3MuZ2V0KFdJS0lGVU5DVElPTlNfQVBJX1VSTCwgeyBwYXJhbXMsIGhlYWRlcnM6IHsgXCJVc2VyLUFnZW50XCI6IFwiTXlXaWtpRnVuY3Rpb25zVG9vbC8xLjBcIiB9IH0pO1xuICAgIGNvbnN0IGZ1bmN0aW9uRGF0YVN0cmluZyA9IHJlc3BvbnNlLmRhdGFbZnVuY3Rpb25JZF0/Lndpa2lsYW1iZGFfZmV0Y2g7XG4gICAgaWYgKGZ1bmN0aW9uRGF0YVN0cmluZykge1xuICAgICAgcmV0dXJuIEpTT04ucGFyc2UoZnVuY3Rpb25EYXRhU3RyaW5nKTtcbiAgICB9XG4gIH0gY2F0Y2ggKGVycm9yOiBhbnkpIHtcbiAgICBjb25zb2xlLmVycm9yKGBFcnJvciBmZXRjaGluZyBkZXRhaWxzIGZvciAke2Z1bmN0aW9uSWR9OmAsIGVycm9yLnJlc3BvbnNlID8gZXJyb3IucmVzcG9uc2UuZGF0YSA6IGVycm9yLm1lc3NhZ2UpO1xuICAgIHJldHVybiBudWxsO1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiBnZXRJbXBsZW1lbnRhdGlvbnMoZnVuY3Rpb25EYXRhOiBhbnkpOiBzdHJpbmdbXSB7XG4gIHRyeSB7XG4gICAgY29uc3QgaW1wbGVtZW50YXRpb25SZWZzID0gZnVuY3Rpb25EYXRhPy5aMksyPy5aOEs0Py5zbGljZSgxKSB8fCBbXTtcbiAgICByZXR1cm4gaW1wbGVtZW50YXRpb25SZWZzLm1hcCgoaW1wbDogYW55KSA9PiB0eXBlb2YgaW1wbCA9PT0gJ3N0cmluZycgPyBpbXBsIDogaW1wbC5aMTRLMSkuZmlsdGVyKEJvb2xlYW4pO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIHJldHVybiBbXTtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBnZXRDb2RlKGltcGxlbWVudGF0aW9uSWQ6IHN0cmluZyk6IFByb21pc2U8c3RyaW5nIHwgbnVsbD4ge1xuICBjb25zdCBpbXBsZW1lbnRhdGlvbkRhdGEgPSBhd2FpdCBnZXRGdW5jdGlvbkRldGFpbHMoaW1wbGVtZW50YXRpb25JZCk7XG4gIGlmICghaW1wbGVtZW50YXRpb25EYXRhKSB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgdHJ5IHtcbiAgICBjb25zdCBjb2RlID0gaW1wbGVtZW50YXRpb25EYXRhPy5aMksyPy5aMTRLMz8uWjE2SzI7XG4gICAgcmV0dXJuIGNvZGUgfHwgbnVsbDtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG5mdW5jdGlvbiBnZXRFbmdsaXNoTGFiZWwobXVsdGlsaW5ndWFsTGlzdDogYW55KTogc3RyaW5nIHtcbiAgaWYgKCFBcnJheS5pc0FycmF5KG11bHRpbGluZ3VhbExpc3QpKSB7XG4gICAgcmV0dXJuIFwiTi9BXCI7XG4gIH1cbiAgZm9yIChjb25zdCBpdGVtIG9mIG11bHRpbGluZ3VhbExpc3QpIHtcbiAgICBpZiAoaXRlbSAmJiB0eXBlb2YgaXRlbSA9PT0gXCJvYmplY3RcIiAmJiBpdGVtLloxMUsxID09PSBcIloxMDAyXCIpIHtcbiAgICAgIHJldHVybiBpdGVtLloxMUsyIHx8IFwiTGFiZWwgbm90IGZvdW5kXCI7XG4gICAgfVxuICB9XG4gIHJldHVybiBcIkVuZ2xpc2ggbGFiZWwgbm90IGZvdW5kXCI7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGdldE11bHRpcGxlRGV0YWlscyh6aWRzOiBzdHJpbmdbXSk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgYW55Pj4ge1xuICBpZiAoIXppZHMgfHwgemlkcy5sZW5ndGggPT09IDApIHtcbiAgICByZXR1cm4ge307XG4gIH1cblxuICBjb25zdCB6aWRTdHJpbmcgPSB6aWRzLmpvaW4oXCJ8XCIpO1xuICBjb25zdCBwYXJhbXMgPSB7XG4gICAgYWN0aW9uOiBcIndpa2lsYW1iZGFfZmV0Y2hcIixcbiAgICBmb3JtYXQ6IFwianNvblwiLFxuICAgIHppZHM6IHppZFN0cmluZyxcbiAgfSBhcyBjb25zdDtcblxuICB0cnkge1xuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgYXhpb3MuZ2V0KFdJS0lGVU5DVElPTlNfQVBJX1VSTCwge1xuICAgICAgcGFyYW1zLFxuICAgICAgaGVhZGVyczogeyBcIlVzZXItQWdlbnRcIjogXCJNeVdpa2lGdW5jdGlvbnNUb29sLzEuMFwiIH0sXG4gICAgfSk7XG4gICAgY29uc3QgZGF0YSA9IHJlc3BvbnNlLmRhdGEgfHwge307XG4gICAgY29uc3QgcmVzdWx0czogUmVjb3JkPHN0cmluZywgYW55PiA9IHt9O1xuICAgIGZvciAoY29uc3QgemlkIG9mIHppZHMpIHtcbiAgICAgIGNvbnN0IHJhdyA9IGRhdGE/Llt6aWRdPy53aWtpbGFtYmRhX2ZldGNoO1xuICAgICAgaWYgKHJhdykge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHJlc3VsdHNbemlkXSA9IEpTT04ucGFyc2UocmF3KTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgLy8gaWdub3JlIHBhcnNlIGVycm9ycyBmb3IgaW5kaXZpZHVhbCBlbnRyaWVzXG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHJlc3VsdHM7XG4gIH0gY2F0Y2ggKGVycm9yOiBhbnkpIHtcbiAgICBjb25zb2xlLmVycm9yKFxuICAgICAgXCJFcnJvciBmZXRjaGluZyBtdWx0aXBsZSBkZXRhaWxzOlwiLFxuICAgICAgZXJyb3IucmVzcG9uc2UgPyBlcnJvci5yZXNwb25zZS5kYXRhIDogZXJyb3IubWVzc2FnZVxuICAgICk7XG4gICAgcmV0dXJuIHt9O1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGJ1aWxkRnVuY3Rpb25DYWxsVGVtcGxhdGUoZnVuY0RlZjogYW55KTogUHJvbWlzZTxhbnk+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBmdW5jdGlvbklkID0gZnVuY0RlZj8uWjJLMT8uWjZLMTtcbiAgICBjb25zdCBmdW5jdGlvbk5hbWUgPSBnZXRFbmdsaXNoTGFiZWwoZnVuY0RlZj8uWjJLMz8uWjEySzEpO1xuICAgIGNvbnN0IGZ1bmN0aW9uRGVzYyA9IGdldEVuZ2xpc2hMYWJlbChmdW5jRGVmPy5aMks1Py5aMTJLMSk7XG4gICAgY29uc3Qgb3V0cHV0VHlwZSA9IGZ1bmNEZWY/LloySzI/Llo4SzI7XG5cbiAgICBjb25zdCBjYWxsVGVtcGxhdGU6IFJlY29yZDxzdHJpbmcsIGFueT4gPSB7XG4gICAgICBfZnVuY3Rpb25fbmFtZTogZnVuY3Rpb25OYW1lLFxuICAgICAgX2Z1bmN0aW9uX2Rlc2NyaXB0aW9uOiBmdW5jdGlvbkRlc2MsXG4gICAgICBfb3V0cHV0X3R5cGU6IG91dHB1dFR5cGUsXG4gICAgICBaMUsxOiBcIlo3XCIsXG4gICAgICBaN0sxOiBmdW5jdGlvbklkLFxuICAgIH07XG5cbiAgICBjb25zdCBhcmd1bWVudERlZmluaXRpb25zOiBhbnlbXSA9IGZ1bmNEZWY/LloySzI/Llo4SzE/LnNsaWNlKDEpIHx8IFtdO1xuICAgIGNvbnN0IHR5cGVaaWRzID0gQXJyYXkuZnJvbShcbiAgICAgIG5ldyBTZXQoXG4gICAgICAgIGFyZ3VtZW50RGVmaW5pdGlvbnNcbiAgICAgICAgICAubWFwKChhcmcpID0+IGFyZz8uWjE3SzEpXG4gICAgICAgICAgLmZpbHRlcigoemlkOiBhbnkpID0+IHR5cGVvZiB6aWQgPT09IFwic3RyaW5nXCIpXG4gICAgICApXG4gICAgKTtcblxuICAgIGNvbnN0IHR5cGVEZXRhaWxzID0gYXdhaXQgZ2V0TXVsdGlwbGVEZXRhaWxzKHR5cGVaaWRzKTtcbiAgICBjb25zdCB0eXBlTmFtZU1hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuICAgIGZvciAoY29uc3QgemlkIG9mIHR5cGVaaWRzKSB7XG4gICAgICBjb25zdCBkZXRhaWxzID0gdHlwZURldGFpbHNbemlkXTtcbiAgICAgIGNvbnN0IG5hbWUgPSBnZXRFbmdsaXNoTGFiZWwoZGV0YWlscz8uWjJLMz8uWjEySzEpO1xuICAgICAgdHlwZU5hbWVNYXBbemlkXSA9IG5hbWUgfHwgXCJVbmtub3duXCI7XG4gICAgfVxuXG4gICAgZm9yIChjb25zdCBhcmdEZWYgb2YgYXJndW1lbnREZWZpbml0aW9ucykge1xuICAgICAgaWYgKCFhcmdEZWYpIGNvbnRpbnVlO1xuICAgICAgY29uc3QgYXJndW1lbnRLZXkgPSBhcmdEZWYuWjE3SzI7XG4gICAgICBjb25zdCByZXF1aXJlZFR5cGVJZCA9IGFyZ0RlZi5aMTdLMTtcbiAgICAgIGNvbnN0IGFyZ3VtZW50TmFtZSA9IGdldEVuZ2xpc2hMYWJlbChhcmdEZWY/LloxN0szPy5aMTJLMSk7XG4gICAgICBjb25zdCB0eXBlTmFtZSA9IHR5cGVOYW1lTWFwW3JlcXVpcmVkVHlwZUlkXSB8fCBcIlVua25vd25cIjtcblxuICAgICAgaWYgKGFyZ3VtZW50S2V5KSB7XG4gICAgICAgIGNhbGxUZW1wbGF0ZVthcmd1bWVudEtleV0gPSB7XG4gICAgICAgICAgbmFtZTogYXJndW1lbnROYW1lLFxuICAgICAgICAgIHJlcXVpcmVkX3R5cGU6IGAke3JlcXVpcmVkVHlwZUlkfSAoJHt0eXBlTmFtZX0pYCxcbiAgICAgICAgICB2YWx1ZTogYDxQcm92aWRlIGEgdmFsdWUgZm9yICcke2FyZ3VtZW50TmFtZX0nPmAsXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIGNhbGxUZW1wbGF0ZTtcbiAgfSBjYXRjaCAoZXJyb3I6IGFueSkge1xuICAgIHJldHVybiB7IGVycm9yOiBgQ291bGQgbm90IGJ1aWxkIHRlbXBsYXRlOiAke2Vycm9yPy5tZXNzYWdlIHx8IFN0cmluZyhlcnJvcil9YCB9O1xuICB9XG59XG5cbmZ1bmN0aW9uIHBhcnNlUmVxdWlyZWRUeXBlWmlkKHJlcXVpcmVkVHlwZTogc3RyaW5nIHwgdW5kZWZpbmVkKTogc3RyaW5nIHwgbnVsbCB7XG4gIGlmICghcmVxdWlyZWRUeXBlIHx8IHR5cGVvZiByZXF1aXJlZFR5cGUgIT09IFwic3RyaW5nXCIpIHJldHVybiBudWxsO1xuICAvLyBFeHBlY3RlZCBmb3JtYXQ6IFwiWjEyMyAoVHlwZU5hbWUpXCIg4oaSIHRha2UgdGhlIGZpcnN0IHRva2VuIHN0YXJ0aW5nIHdpdGggJ1onXG4gIGNvbnN0IG1hdGNoID0gcmVxdWlyZWRUeXBlLm1hdGNoKC9aXFxkKy8pO1xuICByZXR1cm4gbWF0Y2ggPyBtYXRjaFswXSA6IG51bGw7XG59XG5cbmZ1bmN0aW9uIGlzQWxyZWFkeVpPYmplY3QodmFsdWU6IGFueSk6IGJvb2xlYW4ge1xuICByZXR1cm4gdmFsdWUgJiYgdHlwZW9mIHZhbHVlID09PSBcIm9iamVjdFwiICYmIHR5cGVvZiB2YWx1ZS5aMUsxID09PSBcInN0cmluZ1wiO1xufVxuXG5mdW5jdGlvbiB0cmFuc2Zvcm1UZW1wbGF0ZVRvRnVuY3Rpb25DYWxsKFxuICB0ZW1wbGF0ZTogYW55LFxuICBwcm92aWRlZFZhbHVlczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fVxuKTogYW55IHtcbiAgaWYgKCF0ZW1wbGF0ZSB8fCB0eXBlb2YgdGVtcGxhdGUgIT09IFwib2JqZWN0XCIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJJbnZhbGlkIHRlbXBsYXRlIG9iamVjdFwiKTtcbiAgfVxuXG4gIGNvbnN0IGNhbGw6IFJlY29yZDxzdHJpbmcsIGFueT4gPSB7XG4gICAgWjFLMTogXCJaN1wiLFxuICAgIFo3SzE6IHRlbXBsYXRlLlo3SzEsXG4gIH07XG5cbiAgY29uc3QgYXJndW1lbnRLZXlzID0gT2JqZWN0LmtleXModGVtcGxhdGUpLmZpbHRlcihcbiAgICAoaykgPT4gL15aXFxkK0tcXGQrJC8udGVzdChrKSAmJiB0ZW1wbGF0ZVtrXSAmJiB0eXBlb2YgdGVtcGxhdGVba10gPT09IFwib2JqZWN0XCJcbiAgKTtcblxuICBmb3IgKGNvbnN0IGFyZ0tleSBvZiBhcmd1bWVudEtleXMpIHtcbiAgICBjb25zdCBhcmdEZXNjcmlwdG9yID0gdGVtcGxhdGVbYXJnS2V5XTtcbiAgICBjb25zdCByZXF1aXJlZFR5cGVaaWQgPSBwYXJzZVJlcXVpcmVkVHlwZVppZChhcmdEZXNjcmlwdG9yPy5yZXF1aXJlZF90eXBlKTtcblxuICAgIC8vIFJlc29sdmUgdmFsdWUgcHJpb3JpdHk6IHByb3ZpZGVkVmFsdWVzW2FyZ0tleV0g4oaSIHByb3ZpZGVkVmFsdWVzW25hbWVdIOKGkiBkZXNjcmlwdG9yLnZhbHVlXG4gICAgY29uc3QgbmFtZUtleSA9IChhcmdEZXNjcmlwdG9yPy5uYW1lIHx8IFwiXCIpLnRvU3RyaW5nKCk7XG4gICAgY29uc3QgcHJvdmlkZWQgPVxuICAgICAgT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKHByb3ZpZGVkVmFsdWVzLCBhcmdLZXkpXG4gICAgICAgID8gcHJvdmlkZWRWYWx1ZXNbYXJnS2V5XVxuICAgICAgICA6IE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChwcm92aWRlZFZhbHVlcywgbmFtZUtleSlcbiAgICAgICAgPyAocHJvdmlkZWRWYWx1ZXMgYXMgYW55KVtuYW1lS2V5XVxuICAgICAgICA6IGFyZ0Rlc2NyaXB0b3I/LnZhbHVlO1xuXG4gICAgaWYgKGlzQWxyZWFkeVpPYmplY3QocHJvdmlkZWQpKSB7XG4gICAgICBjYWxsW2FyZ0tleV0gPSBwcm92aWRlZDtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIC8vIEZhbGxiYWNrOiBpZiBwcm92aWRlZCBpcyBzdGlsbCBhIHBsYWNlaG9sZGVyIHN0cmluZyBsaWtlIDxQcm92aWRlIC4uLj4sIHRocm93XG4gICAgaWYgKHR5cGVvZiBwcm92aWRlZCA9PT0gXCJzdHJpbmdcIiAmJiAvPFxccypQcm92aWRlXFxiL2kudGVzdChwcm92aWRlZCkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYE1pc3NpbmcgdmFsdWUgZm9yIGFyZ3VtZW50ICcke2FyZ0tleX0nICgke25hbWVLZXl9KS4gUGxlYXNlIHByb3ZpZGUgaXQgaW4gdmFsdWVzX2pzb24uYFxuICAgICAgKTtcbiAgICB9XG5cbiAgICAvLyBXcmFwIHRoZSBwcmltaXRpdmUgdmFsdWUgaW4gYSBaLW9iamVjdCwgdXNpbmcgdGhlIHNwZWNpZmljIHR5cGUgZnJvbSB0aGUgdGVtcGxhdGUuXG4gICAgaWYgKCFyZXF1aXJlZFR5cGVaaWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYENvdWxkIG5vdCBkZXRlcm1pbmUgcmVxdWlyZWQgdHlwZSBmb3IgYXJndW1lbnQgJyR7YXJnS2V5fScgKCR7bmFtZUtleX0pIGZyb20gdGhlIHRlbXBsYXRlLmBcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY2FsbFthcmdLZXldID0gY29udmVydFZhbHVlVG9aT2JqZWN0KHByb3ZpZGVkLCByZXF1aXJlZFR5cGVaaWQpO1xuICB9XG5cbiAgcmV0dXJuIGNhbGw7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJ1bldpa2lmdW5jdGlvbkNhbGwoZnVuY3Rpb25DYWxsOiBhbnkgfCBzdHJpbmcpOiBQcm9taXNlPHsgcmF3OiBhbnk7IGV4dHJhY3RlZD86IGFueSB9PiB7XG4gIGNvbnN0IGZ1bmN0aW9uQ2FsbEpzb24gPVxuICAgIHR5cGVvZiBmdW5jdGlvbkNhbGwgPT09IFwic3RyaW5nXCIgPyBmdW5jdGlvbkNhbGwgOiBKU09OLnN0cmluZ2lmeShmdW5jdGlvbkNhbGwpO1xuXG4gIGNvbnN0IHBhcmFtcyA9IHtcbiAgICBhY3Rpb246IFwid2lraWZ1bmN0aW9uc19ydW5cIixcbiAgICBmb3JtYXQ6IFwianNvblwiLFxuICAgIGZvcm1hdHZlcnNpb246IDIsXG4gICAgZnVuY3Rpb25fY2FsbDogZnVuY3Rpb25DYWxsSnNvbixcbiAgfSBhcyBjb25zdDtcblxuICB0cnkge1xuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgYXhpb3MuZ2V0KFdJS0lGVU5DVElPTlNfQVBJX1VSTCwge1xuICAgICAgcGFyYW1zLFxuICAgICAgaGVhZGVyczogeyBcIlVzZXItQWdlbnRcIjogXCJNeVdpa2lGdW5jdGlvbnNUb29sLzEuMFwiIH0sXG4gICAgfSk7XG4gICAgY29uc3QgcmF3ID0gcmVzcG9uc2UuZGF0YTtcbiAgICBjb25zdCBpbm5lciA9IHJhdz8ud2lraWZ1bmN0aW9uc19ydW4/LmRhdGE7XG4gICAgaWYgKHR5cGVvZiBpbm5lciA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShpbm5lcik7XG4gICAgICAgIGNvbnN0IGV4dHJhY3RlZCA9IHBhcnNlZD8uWjIySzE/LloxMzUxOEsxID8/IHBhcnNlZD8uWjIySzEgPz8gcGFyc2VkO1xuICAgICAgICByZXR1cm4geyByYXc6IHBhcnNlZCwgZXh0cmFjdGVkIH07XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLy8gTm90IEpTT04sIHJldHVybiByYXdcbiAgICAgICAgcmV0dXJuIHsgcmF3IH07XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiB7IHJhdyB9O1xuICB9IGNhdGNoIChlcnJvcjogYW55KSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEVycm9yIHJ1bm5pbmcgV2lraWZ1bmN0aW9uIGNhbGw6ICR7ZXJyb3I/LnJlc3BvbnNlPy5kYXRhIHx8IGVycm9yPy5tZXNzYWdlIHx8IFN0cmluZyhlcnJvcil9YFxuICAgICk7XG4gIH1cbn1cblxuY29uc3Qgc2VydmVyID0gbmV3IE1jcFNlcnZlcih7XG4gIG5hbWU6IFwid2lraWZ1bmN0aW9uc1wiLFxuICB2ZXJzaW9uOiBcIjEuMC4wXCIsXG4gIGNhcGFiaWxpdGllczoge1xuICAgIHJlc291cmNlczoge30sXG4gICAgdG9vbHM6IHt9LFxuICB9LFxufSk7XG5cblxuc2VydmVyLnRvb2woXG4gIFwiZmluZF9jb2RlXCIsXG4gIFwiRmluZHMgdGhlIGZpcnN0IGF2YWlsYWJsZSBjb2RlIGltcGxlbWVudGF0aW9uIGZvciBhIGdpdmVuIHNlYXJjaCBxdWVyeSBvbiBXaWtpRnVuY3Rpb25zLlwiLFxuICB7XG4gICAgc2VhcmNoX3F1ZXJ5OiB6XG4gICAgICAuc3RyaW5nKClcbiAgICAgIC5kZXNjcmliZShcIlRoZSBzZWFyY2ggcXVlcnkgdG8gZmluZCBjb2RlIGZvci4gSnVzdCBhIHN0cmluZyBsaWtlICdhZGQnIG9yICdmaWJvbmFjY2knLlwiKSxcbiAgfSxcbiAgYXN5bmMgKHsgc2VhcmNoX3F1ZXJ5IH0pID0+IHtcbiAgICB0cnkge1xuICAgICAgY29uc29sZS5sb2coYFNlYXJjaGluZyBmb3IgY29kZSBmb3IgcXVlcnk6IFwiJHtzZWFyY2hfcXVlcnl9XCJgKTtcbiAgICAgIFxuICAgICAgLy8gU3RlcCAxOiBGaW5kIGZ1bmN0aW9ucy5cbiAgICAgIGNvbnN0IGZ1bmN0aW9uc1Jlc3BvbnNlID0gYXdhaXQgZmluZEZ1bmN0aW9ucyhzZWFyY2hfcXVlcnkpO1xuICAgICAgaWYgKCdlcnJvcicgaW4gZnVuY3Rpb25zUmVzcG9uc2UpIHtcbiAgICAgICAgcmV0dXJuIHsgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGZ1bmN0aW9uc1Jlc3BvbnNlLmVycm9yIH1dIH07XG4gICAgICB9XG4gICAgICBcbiAgICAgIGlmICghZnVuY3Rpb25zUmVzcG9uc2UgfHwgZnVuY3Rpb25zUmVzcG9uc2UubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIHJldHVybiB7IGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgTm8gZnVuY3Rpb25zIGZvdW5kIGZvciAnJHtzZWFyY2hfcXVlcnl9Jy5gIH1dIH07XG4gICAgICB9XG5cbiAgICAgIC8vIFN0ZXAgMjogSXRlcmF0ZSB0aHJvdWdoIGZ1bmN0aW9ucy5cbiAgICAgIGZvciAoY29uc3QgZnVuYyBvZiBmdW5jdGlvbnNSZXNwb25zZSkge1xuICAgICAgICBjb25zdCBmdW5jdGlvbklkID0gZnVuYy5wYWdlX3RpdGxlO1xuICAgICAgICBjb25zdCBsYWJlbCA9IGZ1bmMubGFiZWwgfHwgJ04vQSc7XG4gICAgICAgIGNvbnNvbGUubG9nKGAtLS0gQ2hlY2tpbmcgZnVuY3Rpb246ICR7ZnVuY3Rpb25JZH0gKCR7bGFiZWx9KSAtLS1gKTtcblxuICAgICAgICBjb25zdCBmdW5jdGlvbkRhdGEgPSBhd2FpdCBnZXRGdW5jdGlvbkRldGFpbHMoZnVuY3Rpb25JZCk7XG4gICAgICAgIGlmICghZnVuY3Rpb25EYXRhKSB7XG4gICAgICAgICAgICBjb25zb2xlLmxvZyhgQ291bGQgbm90IHJldHJpZXZlIGRldGFpbHMgZm9yIGZ1bmN0aW9uICR7ZnVuY3Rpb25JZH0uYCk7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IGltcGxlbWVudGF0aW9ucyA9IGdldEltcGxlbWVudGF0aW9ucyhmdW5jdGlvbkRhdGEpO1xuICAgICAgICBpZiAoaW1wbGVtZW50YXRpb25zLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAgICAgY29uc29sZS5sb2coYE5vIGltcGxlbWVudGF0aW9ucyBmb3VuZCBmb3IgZnVuY3Rpb24gJHtmdW5jdGlvbklkfS5gKTtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gU3RlcCAzOiBJdGVyYXRlIHRocm91Z2ggaW1wbGVtZW50YXRpb25zLlxuICAgICAgICBmb3IgKGNvbnN0IGltcGxJZCBvZiBpbXBsZW1lbnRhdGlvbnMpIHtcbiAgICAgICAgICAgIGNvbnNvbGUubG9nKGAgIENoZWNraW5nIGltcGxlbWVudGF0aW9uOiAke2ltcGxJZH0uLi5gKTtcbiAgICAgICAgICAgIGNvbnN0IGNvZGUgPSBhd2FpdCBnZXRDb2RlKGltcGxJZCk7XG4gICAgICAgICAgICBpZiAoY29kZSkge1xuICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGAgIFNVQ0NFU1M6IEZvdW5kIGNvZGUgaW4gaW1wbGVtZW50YXRpb24gJHtpbXBsSWR9YCk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAgICAgY29udGVudDogW1xuICAgICAgICAgICAgICAgICAgICAgICAgeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYFxcYFxcYFxcYFxcbiR7Y29kZX1cXG5cXGBcXGBcXGBgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICB7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgRm91bmQgaW4gaW1wbGVtZW50YXRpb24gJHtpbXBsSWR9IG9mIGZ1bmN0aW9uICR7ZnVuY3Rpb25JZH0gKCR7bGFiZWx9KS5gIH1cbiAgICAgICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGNvbnNvbGUubG9nKGBObyBjb2RlIGZvdW5kIGluIGFueSBpbXBsZW1lbnRhdGlvbnMgZm9yIGZ1bmN0aW9uICR7ZnVuY3Rpb25JZH0uYCk7XG4gICAgICB9XG4gICAgICBcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgT3BlcmF0aW9uIGNvbXBsZXRlLiBObyBjb2RlIGZvdW5kIGZvciBhbnkgZnVuY3Rpb24gbWF0Y2hpbmcgJyR7c2VhcmNoX3F1ZXJ5fScuYCB9XSxcbiAgICAgIH07XG5cbiAgICB9IGNhdGNoIChlcnJvcjogYW55KSB7XG4gICAgICBjb25zb2xlLmVycm9yKFwiRXJyb3IgaW4gZmluZF9jb2RlOlwiLCBlcnJvci5yZXNwb25zZSA/IGVycm9yLnJlc3BvbnNlLmRhdGEgOiBlcnJvci5tZXNzYWdlKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIkVycm9yIHNlYXJjaGluZyBmb3IgY29kZS5cIiB9XSxcbiAgICAgIH07XG4gICAgfVxuICB9XG4pO1xuXG5zZXJ2ZXIudG9vbChcbiAgXCJnZXRfdGVtcGxhdGVcIixcbiAgXCJCdWlsZHMgYSBmdW5jdGlvbiBjYWxsIHRlbXBsYXRlICh3aXRoIGFyZ3VtZW50IG5hbWVzIGFuZCB0eXBlcykgZm9yIGEgV2lraWZ1bmN0aW9ucyBmdW5jdGlvbiB0aGF0IG1hdGNoZXMgdGhlIGdpdmVuIHF1ZXJ5LlwiLFxuICB7XG4gICAgc2VhcmNoX3F1ZXJ5OiB6XG4gICAgICAuc3RyaW5nKClcbiAgICAgIC5kZXNjcmliZShcbiAgICAgICAgXCJUaGUgc2VhcmNoIHF1ZXJ5IHRvIGZpbmQgYSBmdW5jdGlvbiBmb3IuIEp1c3QgYSBzdHJpbmcgbGlrZSAnYWRkJyBvciAnZmlib25hY2NpJy5cIlxuICAgICAgKSxcbiAgfSxcbiAgYXN5bmMgKHsgc2VhcmNoX3F1ZXJ5IH0pID0+IHtcbiAgICB0cnkge1xuICAgICAgY29uc29sZS5sb2coYFNlYXJjaGluZyBmb3IgdGVtcGxhdGUgZm9yIHF1ZXJ5OiBcIiR7c2VhcmNoX3F1ZXJ5fVwiYCk7XG5cbiAgICAgIC8vIFN0ZXAgMTogRmluZCBmdW5jdGlvbnMuXG4gICAgICBjb25zdCBmdW5jdGlvbnNSZXNwb25zZSA9IGF3YWl0IGZpbmRGdW5jdGlvbnMoc2VhcmNoX3F1ZXJ5KTtcbiAgICAgIGlmIChcImVycm9yXCIgaW4gZnVuY3Rpb25zUmVzcG9uc2UpIHtcbiAgICAgICAgcmV0dXJuIHsgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGZ1bmN0aW9uc1Jlc3BvbnNlLmVycm9yIH1dIH07XG4gICAgICB9XG5cbiAgICAgIGlmICghZnVuY3Rpb25zUmVzcG9uc2UgfHwgZnVuY3Rpb25zUmVzcG9uc2UubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgY29udGVudDogW1xuICAgICAgICAgICAgeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYE5vIGZ1bmN0aW9ucyBmb3VuZCBmb3IgJyR7c2VhcmNoX3F1ZXJ5fScuYCB9LFxuICAgICAgICAgIF0sXG4gICAgICAgIH07XG4gICAgICB9XG5cbiAgICAgIC8vIFN0ZXAgMjogSXRlcmF0ZSB0aHJvdWdoIGZ1bmN0aW9ucyBhbmQgYnVpbGQgdGhlIGZpcnN0IGF2YWlsYWJsZSB0ZW1wbGF0ZS5cbiAgICAgIGZvciAoY29uc3QgZnVuYyBvZiBmdW5jdGlvbnNSZXNwb25zZSkge1xuICAgICAgICBjb25zdCBmdW5jdGlvbklkID0gZnVuYy5wYWdlX3RpdGxlO1xuICAgICAgICBjb25zdCBsYWJlbCA9IGZ1bmMubGFiZWwgfHwgXCJOL0FcIjtcbiAgICAgICAgY29uc29sZS5sb2coYC0tLSBCdWlsZGluZyB0ZW1wbGF0ZSBmb3IgZnVuY3Rpb246ICR7ZnVuY3Rpb25JZH0gKCR7bGFiZWx9KSAtLS1gKTtcblxuICAgICAgICBjb25zdCBmdW5jdGlvbkRhdGEgPSBhd2FpdCBnZXRGdW5jdGlvbkRldGFpbHMoZnVuY3Rpb25JZCk7XG4gICAgICAgIGlmICghZnVuY3Rpb25EYXRhKSB7XG4gICAgICAgICAgY29uc29sZS5sb2coYENvdWxkIG5vdCByZXRyaWV2ZSBkZXRhaWxzIGZvciBmdW5jdGlvbiAke2Z1bmN0aW9uSWR9LmApO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgdGVtcGxhdGUgPSBhd2FpdCBidWlsZEZ1bmN0aW9uQ2FsbFRlbXBsYXRlKGZ1bmN0aW9uRGF0YSk7XG4gICAgICAgIGlmICh0ZW1wbGF0ZSAmJiAhdGVtcGxhdGUuZXJyb3IpIHtcbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgY29udGVudDogW1xuICAgICAgICAgICAgICB7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgXFxgXFxgXFxgXFxuJHtKU09OLnN0cmluZ2lmeSh0ZW1wbGF0ZSwgbnVsbCwgMil9XFxuXFxgXFxgXFxgYCB9LFxuICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgdHlwZTogXCJ0ZXh0XCIsXG4gICAgICAgICAgICAgICAgdGV4dDogYFRlbXBsYXRlIGJ1aWx0IGZvciBmdW5jdGlvbiAke2Z1bmN0aW9uSWR9ICgke2xhYmVsfSkuYCxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICByZXR1cm4ge1xuICAgICAgICBjb250ZW50OiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgdHlwZTogXCJ0ZXh0XCIsXG4gICAgICAgICAgICB0ZXh0OiBgT3BlcmF0aW9uIGNvbXBsZXRlLiBObyB0ZW1wbGF0ZSBjb3VsZCBiZSBidWlsdCBmb3IgYW55IGZ1bmN0aW9uIG1hdGNoaW5nICcke3NlYXJjaF9xdWVyeX0nLmAsXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgIH07XG4gICAgfSBjYXRjaCAoZXJyb3I6IGFueSkge1xuICAgICAgY29uc29sZS5lcnJvcihcbiAgICAgICAgXCJFcnJvciBpbiBnZXRfdGVtcGxhdGU6XCIsXG4gICAgICAgIGVycm9yLnJlc3BvbnNlID8gZXJyb3IucmVzcG9uc2UuZGF0YSA6IGVycm9yLm1lc3NhZ2VcbiAgICAgICk7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJFcnJvciBidWlsZGluZyBmdW5jdGlvbiB0ZW1wbGF0ZS5cIiB9XSxcbiAgICAgIH07XG4gICAgfVxuICB9XG4pO1xuXG5zZXJ2ZXIudG9vbChcbiAgXCJydW5fdGVtcGxhdGVcIixcbiAgXCJUcmFuc2Zvcm1zIGEgZnVuY3Rpb24gY2FsbCB0ZW1wbGF0ZSB1c2luZyBwcm92aWRlZCB2YWx1ZXMgYW5kIGV4ZWN1dGVzIGl0IG9uIFdpa2lmdW5jdGlvbnMuXCIsXG4gIHtcbiAgICB0ZW1wbGF0ZV9qc29uOiB6XG4gICAgICAuc3RyaW5nKClcbiAgICAgIC5kZXNjcmliZShcIlRoZSBmdW5jdGlvbiBjYWxsIHRlbXBsYXRlIEpTT04gc3RyaW5nIHByb2R1Y2VkIGJ5IGdldF90ZW1wbGF0ZS5cIiksXG4gICAgdmFsdWVzX2pzb246IHpcbiAgICAgIC5zdHJpbmcoKVxuICAgICAgLm9wdGlvbmFsKClcbiAgICAgIC5kZXNjcmliZShcbiAgICAgICAgYE9wdGlvbmFsIEpTT04gb2JqZWN0IG1hcHBpbmcgYXJndW1lbnQgbmFtZXMgdG8gdGhlaXIgdmFsdWVzLiBGb3IgZXhhbXBsZTogJ3tcImZpcnN0IG51bWJlclwiOiA1LCBcInNlY29uZCBudW1iZXJcIjogN30nLmBcbiAgICAgICksXG4gIH0sXG4gIGFzeW5jICh7IHRlbXBsYXRlX2pzb24sIHZhbHVlc19qc29uIH0pID0+IHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgdGVtcGxhdGUgPSBKU09OLnBhcnNlKHRlbXBsYXRlX2pzb24pO1xuICAgICAgY29uc3QgdmFsdWVzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHZhbHVlc19qc29uID8gSlNPTi5wYXJzZSh2YWx1ZXNfanNvbikgOiB7fTtcblxuICAgICAgY29uc3QgY2FsbE9iamVjdCA9IHRyYW5zZm9ybVRlbXBsYXRlVG9GdW5jdGlvbkNhbGwodGVtcGxhdGUsIHZhbHVlcyk7XG4gICAgICBjb25zdCBjYWxsSnNvbiA9IEpTT04uc3RyaW5naWZ5KGNhbGxPYmplY3QsIG51bGwsIDIpO1xuXG4gICAgICBjb25zdCB7IHJhdyB9ID0gYXdhaXQgcnVuV2lraWZ1bmN0aW9uQ2FsbChjYWxsT2JqZWN0KTtcbiAgICAgIGNvbnN0IGV4dHJhY3RlZCA9IGNvbnZlcnRaT2JqZWN0VG9WYWx1ZShyYXc/LloyMksxKTtcblxuICAgICAgY29uc3QgZGlzcGxheWVkUmVzdWx0ID1cbiAgICAgICAgZXh0cmFjdGVkICYmIHR5cGVvZiBleHRyYWN0ZWQgPT09IFwib2JqZWN0XCJcbiAgICAgICAgICA/IEpTT04uc3RyaW5naWZ5KGV4dHJhY3RlZCwgbnVsbCwgMilcbiAgICAgICAgICA6IGV4dHJhY3RlZCA/PyBcIjxub25lPlwiO1xuXG4gICAgICBjb25zdCBjb250ZW50OiB7IHR5cGU6IFwidGV4dFwiOyB0ZXh0OiBzdHJpbmcgfVtdID0gW1xuICAgICAgICB7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgQ29uc3RydWN0ZWQgQ2FsbDpgIH0sXG4gICAgICAgIHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBcXGBcXGBcXGBcXG4ke2NhbGxKc29ufVxcblxcYFxcYFxcYGAgfSxcbiAgICAgICAgeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYFJlc3VsdCAoZXh0cmFjdGVkKTogJHtkaXNwbGF5ZWRSZXN1bHR9YCB9LFxuICAgICAgXTtcblxuICAgICAgaWYgKHJhdz8uWjIySzE/LloxSzEgPT09IFwiWjI0XCIpIHtcbiAgICAgICAgY29udGVudC5wdXNoKHtcbiAgICAgICAgICB0eXBlOiBcInRleHRcIixcbiAgICAgICAgICB0ZXh0OiBcIk5vdGU6IFRoZSByZXN1bHQgWjI0IGluZGljYXRlcyBhbiBlcnJvciwgd2hpY2ggY291bGQgbWVhbiB0aGUgaW1wbGVtZW50YXRpb24gaXMgZmxhd2VkIG9yIHRoZSBpbnB1dHMgd2VyZSBpbnZhbGlkLiBJIHdpbGwgc2VhcmNoIGZvciB0aGUgY29kZSBvZiB0aGUgZnVuY3Rpb24gYW5kIHJldHVybiBpdC5cIixcbiAgICAgICAgfSk7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiB7IGNvbnRlbnQgfTtcbiAgICB9IGNhdGNoIChlcnJvcjogYW55KSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBjb250ZW50OiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgdHlwZTogXCJ0ZXh0XCIsXG4gICAgICAgICAgICB0ZXh0OiBgRXJyb3IgaW4gcnVuX3RlbXBsYXRlOiAke2Vycm9yPy5tZXNzYWdlIHx8IFN0cmluZyhlcnJvcil9YCxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfTtcbiAgICB9XG4gIH1cbik7XG5cbmFzeW5jIGZ1bmN0aW9uIG1haW4oKSB7XG4gIGNvbnN0IHRyYW5zcG9ydCA9IG5ldyBTdGRpb1NlcnZlclRyYW5zcG9ydCgpO1xuICBhd2FpdCBzZXJ2ZXIuY29ubmVjdCh0cmFuc3BvcnQpO1xuICBjb25zb2xlLmVycm9yKFwiV2lraUZ1bmN0aW9ucyBNQ1AgU2VydmVyIHJ1bm5pbmcgb24gc3RkaW9cIik7XG59XG5cbm1haW4oKS5jYXRjaCgoZXJyb3IpID0+IHtcbiAgY29uc29sZS5lcnJvcihcIkZhdGFsIGVycm9yIGluIG1haW4oKTpcIiwgZXJyb3IpO1xuICBwcm9jZXNzLmV4aXQoMSk7XG59KTtcbiJdfQ==