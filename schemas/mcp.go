package schemas

// McpExecute defines the structure for executing an MCP tool.
type McpExecute struct {
	Tool       string         `json:"tool" doc:"The name of the tool to execute."`
	Parameters map[string]any `json:"parameters,omitempty" doc:"Arbitrary parameters for the tool."`
}
