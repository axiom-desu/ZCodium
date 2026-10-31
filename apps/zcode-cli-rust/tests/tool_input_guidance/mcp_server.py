"""Isolated stdio MCP fixture; remote parser owns input checks and effects."""
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    method = request["method"]
    reply = {"jsonrpc": "2.0", "id": request["id"]}
    if method == "initialize":
        reply["result"] = {
            "protocolVersion": request["params"]["protocolVersion"],
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "input-fixture", "version": "1"},
        }
    elif method == "tools/list":
        reply["result"] = {"tools": [{
            "name": "probe", "description": "Count one actual effect",
            "inputSchema": {"type": "object", "properties": {
                "count": {"type": "integer"}, "failure": {"type": "string"}},
                "required": ["count"]},
        }]}
    elif method == "tools/call":
        args = request["params"]["arguments"]
        with (root / "calls").open("a") as out:
            out.write(json.dumps(args) + "\n")
        failure = args.get("failure")
        if failure == "disconnect":
            sys.exit(1)
        if failure == "response-json":
            print("not JSON", flush=True)
            sys.exit(0)
        if failure == "internal":
            reply["error"] = {"code": -32603, "message": "InputValidationError -32602 is only text"}
        elif failure == "is-error":
            reply["result"] = {"isError": True, "content": [{"type": "text", "text": "exit 1"}]}
        elif not isinstance(args.get("count"), int):
            reply["error"] = {"code": -32602, "message": "count must be numeric", "data": {"field": "count"}}
        else:
            with (root / "effects").open("a") as out:
                out.write(str(args["count"]) + "\n")
            reply["result"] = {"content": [{"type": "text", "text": "effect committed"}]}
    else:
        reply["result"] = {}
    print(json.dumps(reply), flush=True)
