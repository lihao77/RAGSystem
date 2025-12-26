try:
    import llmjson
    print("llmjson: found")
    
    # 检查版本
    if hasattr(llmjson, '__version__'):
        print(f"llmjson version: {llmjson.__version__}")
    
    # 检查v2特性
    try:
        from llmjson import ProcessorFactory
        print("llmjson v2 features: available")
    except ImportError:
        print("llmjson v2 features: not available")
        
except: 
    print("llmjson: not found")

try:
    from nodes.llmjson_v2 import LLMJsonV2Node, LLMJsonV2NodeConfig
    print("llmjson v2 node: available")
except Exception as e:
    print(f"llmjson v2 node: not available - {e}")

try:
    import json2graph
    print("json2graph: found")
except: 
    print("json2graph: not found")
