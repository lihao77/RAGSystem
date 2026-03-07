[CmdletBinding()]
param(
    [string]$PythonCommand = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-PythonCommand {
    param([string]$RequestedCommand)

    if ($RequestedCommand) {
        return $RequestedCommand -split '\s+'
    }

    if (Get-Command py -ErrorAction SilentlyContinue) {
        return @('py', '-3')
    }

    if (Get-Command python -ErrorAction SilentlyContinue) {
        return @('python')
    }

    if (Get-Command python3 -ErrorAction SilentlyContinue) {
        return @('python3')
    }

    throw '未找到可用的 Python 解释器（py -3 / python / python3）'
}

$pythonCommandParts = @(Resolve-PythonCommand -RequestedCommand $PythonCommand)
$script:PythonExe = $pythonCommandParts[0]
if ($pythonCommandParts.Count -gt 1) {
    $script:PythonArgs = $pythonCommandParts[1..($pythonCommandParts.Count - 1)]
} else {
    $script:PythonArgs = @()
}

function Invoke-Python {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    & $script:PythonExe @script:PythonArgs @Arguments
}

$requirementsFile = 'requirements.txt'
if (Test-Path 'requirements.lock.txt') {
    $requirementsFile = 'requirements.lock.txt'
}
$pythonVersion = (Invoke-Python '--version') 2>&1

Write-Host '================================================'
Write-Host '  RAGSystem 依赖安装脚本（Windows PowerShell）'
Write-Host '================================================'
Write-Host ("Python解释器: {0}" -f ($pythonCommandParts -join ' '))
Write-Host ("当前Python版本: {0}" -f $pythonVersion)
Write-Host ("依赖清单: {0}" -f $requirementsFile)
Write-Host ''

Write-Host '[1/5] 检查 Python 版本...'
Invoke-Python '-c' 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'
Write-Host '✅ Python 版本检查通过'
Write-Host ''

Write-Host '[2/5] 升级 pip...'
Invoke-Python '-m' 'pip' 'install' '--upgrade' 'pip'
Write-Host '✅ pip 升级完成'
Write-Host ''

Write-Host '[3/5] 安装后端依赖...'
Invoke-Python '-m' 'pip' 'install' '-r' $requirementsFile
Write-Host '✅ 后端依赖安装完成'
Write-Host ''

Write-Host '[4/5] 验证关键依赖...'
$validationCode = @'
import importlib
import sys

checks = [
    ("flask", "Flask"),
    ("flask_cors", "Flask-CORS"),
    ("neo4j", "neo4j"),
    ("requests", "requests"),
    ("dotenv", "python-dotenv"),
    ("pydantic", "pydantic"),
    ("yaml", "PyYAML"),
    ("coloredlogs", "coloredlogs"),
    ("structlog", "structlog"),
    ("docx", "python-docx"),
    ("tiktoken", "tiktoken"),
    ("json_repair", "json-repair"),
    ("sqlite_vec", "sqlite-vec"),
    ("jieba", "jieba"),
    ("numpy", "numpy"),
    ("pandas", "pandas"),
    ("shapely", "shapely"),
    ("mcp", "mcp"),
    ("llmjson", "llmjson"),
    ("json2graph", "json2graph"),
]

missing = []
for module_name, display_name in checks:
    try:
        importlib.import_module(module_name)
    except Exception as exc:
        missing.append(f"{display_name} ({exc.__class__.__name__}: {exc})")

if missing:
    print("❌ 以下依赖导入失败:")
    for item in missing:
        print(f"  - {item}")
    sys.exit(1)

from model_adapter import ModelAdapter
from vector_store.sqlite_store import SQLiteVectorStore

print("✅ 关键依赖与核心模块导入通过")
print(f"   ModelAdapter: {ModelAdapter.__name__}")
print(f"   SQLiteVectorStore: {SQLiteVectorStore.__name__}")
'@
Invoke-Python '-c' $validationCode
Write-Host '✅ 依赖验证完成'
Write-Host ''

Write-Host '[5/5] 下一步建议...'
Write-Host '  1. Copy-Item .env.example .env'
Write-Host '  2. Copy-Item model_adapter/configs/providers.yaml.example model_adapter/configs/providers.yaml'
Write-Host '  3. 编辑上述文件并填入真实配置'
Write-Host ("  4. 运行: {0} app.py" -f ($pythonCommandParts -join ' '))
Write-Host ''
Write-Host '如需检查配置结构，可运行：'
Write-Host ("  {0} -m config.health_check" -f ($pythonCommandParts -join ' '))
Write-Host ''
Write-Host '================================================'
Write-Host '  🎉 依赖安装流程完成'
Write-Host '================================================'
