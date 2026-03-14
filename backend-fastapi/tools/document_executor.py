# -*- coding: utf-8 -*-
"""
文档处理工具执行器
实现文档读取、分块、结构化提取等功能
"""
import os
import json
import difflib
import tempfile
from typing import Dict, List, Any, Optional
from pathlib import Path

from tools.response_builder import error_result, success_result


DEFAULT_READ_MAX_LINES = 2000
MAX_LINE_CHARS = 2000
FILE_SIZE_PREVIEW_THRESHOLD = 5 * 1024  # 5KB


def _format_line(line_number: int, line_content: str) -> str:
    """Format a single line in cat -n style: '{line_number:>6}\\t{content}'."""
    if len(line_content) > MAX_LINE_CHARS:
        line_content = line_content[:MAX_LINE_CHARS] + " [TRUNCATED]"
    return f"{line_number:>6}\t{line_content}"


def read_document(file_path: str, encoding: str = "utf-8"):
    """读取文档文件内容"""
    file_path = Path(file_path)

    if not file_path.exists():
        return error_result(f"文件不存在: {file_path}", tool_name="read_document")

    suffix = file_path.suffix.lower()

    try:
        # TXT/MD 文件
        if suffix in ['.txt', '.md']:
            with open(file_path, 'r', encoding=encoding) as f:
                content = f.read()
            return success_result(
                content=content,
                summary=f"文档读取成功: {file_path.name}",
                output_type="text",
                metadata={
                    "file_type": suffix[1:],
                    "char_count": len(content),
                    "file_path": str(file_path),
                },
                tool_name="read_document",
            )

        # PDF 文件
        elif suffix == '.pdf':
            try:
                import PyPDF2
                with open(file_path, 'rb') as f:
                    reader = PyPDF2.PdfReader(f)
                    content = ""
                    for page in reader.pages:
                        content += page.extract_text() + "\n"
                return success_result(
                    content=content,
                    summary=f"PDF 读取成功: {file_path.name}",
                    output_type="text",
                    metadata={
                        "file_type": "pdf",
                        "page_count": len(reader.pages),
                        "char_count": len(content),
                        "file_path": str(file_path),
                    },
                    tool_name="read_document",
                )
            except ImportError:
                return error_result("需要安装 PyPDF2: pip install PyPDF2", tool_name="read_document")

        # Word 文件
        elif suffix in ['.docx', '.doc']:
            try:
                import docx
                doc = docx.Document(file_path)
                content = "\n".join([para.text for para in doc.paragraphs])
                return success_result(
                    content=content,
                    summary=f"Word 文档读取成功: {file_path.name}",
                    output_type="text",
                    metadata={
                        "file_type": "docx",
                        "paragraph_count": len(doc.paragraphs),
                        "char_count": len(content),
                        "file_path": str(file_path),
                    },
                    tool_name="read_document",
                )
            except ImportError:
                return error_result("需要安装 python-docx: pip install python-docx", tool_name="read_document")

        else:
            return error_result(f"不支持的文件格式: {suffix}", tool_name="read_document")

    except Exception as e:
        return error_result(f"读取文件失败: {str(e)}", tool_name="read_document")


def chunk_document(
    content: str,
    chunk_size: int = 2000,
    chunk_overlap: int = 200,
    strategy: str = "fixed"
):
    """将长文档分块"""
    try:
        chunks = []

        if strategy == "fixed":
            # 固定大小分块
            start = 0
            chunk_id = 0
            while start < len(content):
                end = start + chunk_size
                chunk_text = content[start:end]
                chunks.append({
                    "chunk_id": chunk_id,
                    "content": chunk_text,
                    "start_pos": start,
                    "end_pos": min(end, len(content)),
                    "char_count": len(chunk_text)
                })
                start = end - chunk_overlap
                chunk_id += 1

        elif strategy == "paragraph":
            # 按段落分块
            paragraphs = content.split('\n\n')
            current_chunk = ""
            chunk_id = 0
            start_pos = 0

            for para in paragraphs:
                if len(current_chunk) + len(para) > chunk_size and current_chunk:
                    chunks.append({
                        "chunk_id": chunk_id,
                        "content": current_chunk.strip(),
                        "start_pos": start_pos,
                        "end_pos": start_pos + len(current_chunk),
                        "char_count": len(current_chunk)
                    })
                    chunk_id += 1
                    start_pos += len(current_chunk)
                    current_chunk = para + "\n\n"
                else:
                    current_chunk += para + "\n\n"

            # 最后一块
            if current_chunk:
                chunks.append({
                    "chunk_id": chunk_id,
                    "content": current_chunk.strip(),
                    "start_pos": start_pos,
                    "end_pos": start_pos + len(current_chunk),
                    "char_count": len(current_chunk)
                })

        elif strategy == "semantic":
            # 语义分块（简化版：按句子分块）
            import re
            sentences = re.split(r'([。！？\n])', content)
            current_chunk = ""
            chunk_id = 0
            start_pos = 0

            for i in range(0, len(sentences), 2):
                sentence = sentences[i] + (sentences[i+1] if i+1 < len(sentences) else "")
                if len(current_chunk) + len(sentence) > chunk_size and current_chunk:
                    chunks.append({
                        "chunk_id": chunk_id,
                        "content": current_chunk.strip(),
                        "start_pos": start_pos,
                        "end_pos": start_pos + len(current_chunk),
                        "char_count": len(current_chunk)
                    })
                    chunk_id += 1
                    start_pos += len(current_chunk)
                    current_chunk = sentence
                else:
                    current_chunk += sentence

            if current_chunk:
                chunks.append({
                    "chunk_id": chunk_id,
                    "content": current_chunk.strip(),
                    "start_pos": start_pos,
                    "end_pos": start_pos + len(current_chunk),
                    "char_count": len(current_chunk)
                })

        return success_result(
            content=chunks,
            summary=f"文档分块成功，共 {len(chunks)} 块",
            output_type="json",
            metadata={
                "total_chunks": len(chunks),
                "strategy": strategy,
                "chunk_size": chunk_size,
                "chunk_overlap": chunk_overlap,
            },
            tool_name="chunk_document",
        )

    except Exception as e:
        return error_result(f"分块失败: {str(e)}", tool_name="chunk_document")


def extract_structured_data(
    text: str,
    schema: Dict[str, Any],
    instruction: Optional[str] = None,
    examples: Optional[List[Dict]] = None
):
    """从文本中提取结构化数据（使用 LLM）"""
    try:
        from model_adapter import get_default_adapter

        adapter = get_default_adapter()

        # 构建提示词
        prompt = f"""请从以下文本中提取结构化信息，严格按照 JSON Schema 格式返回。

JSON Schema:
{json.dumps(schema, ensure_ascii=False, indent=2)}
"""

        if instruction:
            prompt += f"\n提取要求：\n{instruction}\n"

        if examples:
            prompt += f"\n示例格式：\n{json.dumps(examples[0], ensure_ascii=False, indent=2)}\n"

        prompt += f"\n文本内容：\n{text}\n\n请直接返回 JSON 格式的提取结果，不要包含任何其他说明文字。"

        # 调用 LLM（使用 JSON mode）
        response = adapter.chat_completion(
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"}
        )

        # 解析结果
        result_text = response.get("content", "")
        extracted_data = json.loads(result_text)

        return success_result(
            content=extracted_data,
            summary="结构化提取成功",
            output_type="json",
            metadata={"text_length": len(text)},
            tool_name="extract_structured_data",
        )

    except Exception as e:
        return error_result(f"提取失败: {str(e)}", tool_name="extract_structured_data")


def merge_extracted_data(
    data_list: List[Dict],
    merge_strategy: str = "deduplicate",
    unique_key: Optional[str] = None
):
    """合并多个提取结果"""
    try:
        if merge_strategy == "append":
            # 简单追加
            merged = []
            for data in data_list:
                if isinstance(data, list):
                    merged.extend(data)
                else:
                    merged.append(data)

        elif merge_strategy == "deduplicate":
            # 去重
            if not unique_key:
                return error_result("去重策略需要指定 unique_key", tool_name="merge_extracted_data")

            seen = set()
            merged = []
            for data in data_list:
                items = data if isinstance(data, list) else [data]
                for item in items:
                    key_value = item.get(unique_key)
                    if key_value and key_value not in seen:
                        seen.add(key_value)
                        merged.append(item)

        elif merge_strategy == "merge_by_key":
            # 按键合并（相同键的数据合并）
            if not unique_key:
                return error_result("按键合并策略需要指定 unique_key", tool_name="merge_extracted_data")

            merged_dict = {}
            for data in data_list:
                items = data if isinstance(data, list) else [data]
                for item in items:
                    key_value = item.get(unique_key)
                    if key_value:
                        if key_value in merged_dict:
                            # 合并字段
                            merged_dict[key_value].update(item)
                        else:
                            merged_dict[key_value] = item
            merged = list(merged_dict.values())

        return success_result(
            content=merged,
            summary=f"提取结果合并成功，共 {len(merged)} 项",
            output_type="json",
            metadata={
                "total_items": len(merged),
                "merge_strategy": merge_strategy,
                "unique_key": unique_key,
            },
            tool_name="merge_extracted_data",
        )

    except Exception as e:
        return error_result(f"合并失败: {str(e)}", tool_name="merge_extracted_data")


def write_file(
    content: str,
    file_path: Optional[str] = None,
    encoding: str = "utf-8",
    mode: str = "text",
) -> Any:
    """写入文本内容到文件。JSON 请先用 json.dumps 序列化为字符串再传入。"""
    try:
        if not file_path:
            temp_dir = tempfile.gettempdir()
            suffix = ".json" if mode == "json" else ".txt"
            file_path = os.path.join(temp_dir, f"output_{os.getpid()}{suffix}")

        dir_path = os.path.dirname(file_path)
        if dir_path:
            os.makedirs(dir_path, exist_ok=True)

        with open(file_path, 'w', encoding=encoding) as f:
            if mode == "json":
                if isinstance(content, str):
                    try:
                        json.dump(json.loads(content), f, ensure_ascii=False, indent=2)
                    except json.JSONDecodeError:
                        f.write(content)
                else:
                    json.dump(content, f, ensure_ascii=False, indent=2)
            else:
                f.write(content if isinstance(content, str) else str(content))

        file_size = os.path.getsize(file_path)
        return success_result(
            content={"file_path": file_path, "file_size": file_size},
            summary=f"文件已写入: {file_path}（{file_size} 字节）",
            output_type="text",
            tool_name="write_file",
        )

    except Exception as e:
        return error_result(f"写入文件失败: {str(e)}", tool_name="write_file")


def read_file(
    file_path: str,
    encoding: str = "utf-8",
    offset: int = 1,
    limit: int = DEFAULT_READ_MAX_LINES,
    *,
    caller: str = "direct",
    event_bus=None,
    session_id: Optional[str] = None,
) -> Any:
    """按行号读取文件内容，返回 cat -n 格式。支持大文件预览确认（仅 direct 调用）。"""
    try:
        file_path_obj = Path(file_path)

        if not file_path_obj.exists():
            return error_result(f"文件不存在: {file_path}", tool_name="read_file")

        if offset < 1:
            return error_result("offset 必须 >= 1", tool_name="read_file")
        if limit < 1:
            return error_result("limit 必须 >= 1", tool_name="read_file")

        file_size = file_path_obj.stat().st_size

        # 大文件预览确认：仅 caller=="direct" 且有 event_bus/session_id 时触发
        if (
            caller == "direct"
            and file_size > FILE_SIZE_PREVIEW_THRESHOLD
            and event_bus is not None
            and session_id is not None
        ):
            # 读取前 5KB 作为预览
            with open(file_path_obj, "r", encoding=encoding, errors="replace") as f:
                preview_raw = f.read(FILE_SIZE_PREVIEW_THRESHOLD)

            preview_lines = preview_raw.splitlines(keepends=True)
            preview_formatted = "\n".join(
                _format_line(i + 1, line.rstrip("\n\r"))
                for i, line in enumerate(preview_lines)
            )

            # 复用审批机制发布确认事件
            import uuid as _uuid
            from agents.events import Event, EventType
            from agents.task_registry import get_task_registry

            approval_id = str(_uuid.uuid4())
            registry = get_task_registry()
            wait_evt = registry.add_pending_approval(session_id, approval_id)

            event_bus.publish(Event(
                type=EventType.USER_APPROVAL_REQUIRED,
                session_id=session_id,
                data={
                    "approval_id": approval_id,
                    "approval_type": "file_read_confirm",
                    "tool_name": "read_file",
                    "file_path": str(file_path_obj),
                    "file_size": file_size,
                    "preview": preview_formatted,
                    "description": f"文件 {file_path_obj.name} 较大（{file_size} 字节），是否读取完整内容？",
                }
            ))

            if wait_evt is not None:
                wait_evt.wait()
                approved, _ = registry.get_approval_result(session_id, approval_id)
                if not approved:
                    # 用户拒绝 → 返回预览内容
                    return success_result(
                        content=preview_formatted,
                        summary=f"文件预览: {file_path}（仅前 5KB，{file_size} 字节总计）",
                        output_type="text",
                        metadata={
                            "file_path": str(file_path_obj),
                            "file_size": file_size,
                            "preview_only": True,
                            "preview_lines": len(preview_lines),
                        },
                        tool_name="read_file",
                    )

        # 正式读取
        with open(file_path_obj, "r", encoding=encoding, errors="replace") as f:
            all_lines = f.readlines()

        total_lines = len(all_lines)
        start_idx = offset - 1  # 0-based index
        end_idx = min(start_idx + limit, total_lines)

        if start_idx >= total_lines:
            return success_result(
                content="",
                summary=f"offset {offset} 超出文件总行数 {total_lines}",
                output_type="text",
                metadata={
                    "file_path": str(file_path_obj),
                    "file_size": file_size,
                    "total_lines": total_lines,
                    "start_line": offset,
                    "end_line": offset,
                    "has_more": False,
                    "next_offset": None,
                },
                tool_name="read_file",
            )

        selected_lines = all_lines[start_idx:end_idx]
        formatted_lines = [
            _format_line(start_idx + i + 1, line.rstrip("\n\r"))
            for i, line in enumerate(selected_lines)
        ]
        content = "\n".join(formatted_lines)

        has_more = end_idx < total_lines
        actual_end_line = start_idx + len(selected_lines)
        next_offset = actual_end_line + 1 if has_more else None

        summary = (
            f"文件读取成功: {file_path}（行 {offset}-{actual_end_line}，"
            f"共 {total_lines} 行，{file_size} 字节）"
        )
        if has_more:
            summary += f"；还有后续内容，可继续调用 read_file(offset={next_offset})"
        else:
            summary += "；已到文件末尾"

        return success_result(
            content=content,
            summary=summary,
            output_type="text",
            metadata={
                "file_path": str(file_path_obj),
                "file_size": file_size,
                "total_lines": total_lines,
                "start_line": offset,
                "end_line": actual_end_line,
                "has_more": has_more,
                "next_offset": next_offset,
            },
            tool_name="read_file",
        )

    except Exception as e:
        return error_result(f"读取文件失败: {str(e)}", tool_name="read_file")


def edit_file(
    file_path: str,
    old_string: str,
    new_string: str,
    encoding: str = "utf-8",
    replace_all: bool = False,
) -> Any:
    """精准字符串替换编辑文件。old_string 必须唯一匹配（除非 replace_all=True）。"""
    try:
        file_path_obj = Path(file_path)

        if not file_path_obj.exists():
            return error_result(f"文件不存在: {file_path}", tool_name="edit_file")

        with open(file_path_obj, "r", encoding=encoding) as f:
            content = f.read()

        count = content.count(old_string)

        if count == 0:
            return error_result(
                f"未找到匹配内容，请检查 old_string 是否与文件内容完全一致",
                tool_name="edit_file",
            )

        if count > 1 and not replace_all:
            return error_result(
                f"匹配不唯一（找到 {count} 处匹配）。请提供更多上下文使 old_string 唯一，或设 replace_all=true",
                tool_name="edit_file",
            )

        # 执行替换
        if replace_all:
            new_content = content.replace(old_string, new_string)
            replacements = count
        else:
            new_content = content.replace(old_string, new_string, 1)
            replacements = 1

        # 写回文件
        with open(file_path_obj, "w", encoding=encoding) as f:
            f.write(new_content)

        # 构建 unified diff 预览
        old_lines = content.splitlines(keepends=True)
        new_lines = new_content.splitlines(keepends=True)
        diff = difflib.unified_diff(
            old_lines, new_lines,
            fromfile=f"a/{file_path_obj.name}",
            tofile=f"b/{file_path_obj.name}",
        )
        diff_preview = "".join(diff)
        if len(diff_preview) > 2000:
            diff_preview = diff_preview[:2000] + "\n... [DIFF TRUNCATED]"

        new_size = file_path_obj.stat().st_size

        return success_result(
            content={
                "file_path": str(file_path_obj),
                "replacements": replacements,
                "file_size": new_size,
                "diff_preview": diff_preview,
            },
            summary=f"文件编辑成功: {file_path}（替换 {replacements} 处，{new_size} 字节）",
            output_type="json",
            metadata={
                "file_path": str(file_path_obj),
                "replacements": replacements,
                "file_size": new_size,
            },
            tool_name="edit_file",
        )

    except Exception as e:
        return error_result(f"编辑文件失败: {str(e)}", tool_name="edit_file")


