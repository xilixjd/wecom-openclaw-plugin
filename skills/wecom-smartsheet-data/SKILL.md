---
name: wecom-smartsheet-data
description: 企业微信智能表格数据（记录）管理技能。提供智能表格记录的增删改查能力。适用场景：(1) 查询子表全部记录 (2) 添加一行或多行记录 (3) 更新已有记录 (4) 删除记录。当用户需要读取表格数据、写入新数据、修改或删除表格行时触发此 Skill。支持通过 docid 或文档 URL 定位文档。
---

# 企业微信智能表格数据管理

> `wecom_mcp` 是一个 MCP tool，所有操作通过调用该 tool 完成。

> ⚠️ **前置条件**：首次调用 `wecom_mcp` 前，必须按 `wecom-preflight` 技能执行前置条件检查，确保工具已加入白名单。

管理智能表格中的记录（行数据）。所有接口支持通过 `docid` 或 `url` 二选一定位文档。

## CLI 调用方式

通过 `wecom_mcp` tool 调用，品类为 `doc`：

使用 `wecom_mcp` tool 调用 `wecom_mcp call doc <tool_name> '<json_params>'` 调用指定技能

## 返回格式说明

所有接口返回 JSON 对象，包含以下公共字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `errcode` | integer | 返回码，`0` 表示成功，非 `0` 表示失败 |
| `errmsg` | string | 错误信息，成功时为 `"ok"` |

当 `errcode` 不为 `0` 时，说明接口调用失败，可重试 1 次；若仍失败，将 `errcode` 和 `errmsg` 展示给用户。

### smartsheet_get_records

查询子表全部记录。

- 通过 sheetid：使用 `wecom_mcp` tool 调用 `wecom_mcp call doc smartsheet_get_records '{"docid": "DOCID", "sheet_id": "SHEETID"}'`
- 或通过 URL：使用 `wecom_mcp` tool 调用 `wecom_mcp call doc smartsheet_get_records '{"url": "https://doc.weixin.qq.com/smartsheet/xxx", "sheet_id": "SHEETID"}'`

参见 [API 详情](references/api-get-records.md)。

### smartsheet_add_records

添加一行或多行记录，单次建议 500 行内。

**调用前**必须先了解目标表的字段类型（通过 `smartsheet_get_fields`），并查看[单元格值格式参考](references/cell-value-formats.md)，了解做法后再实施。

使用 `wecom_mcp` tool 调用 `wecom_mcp call doc smartsheet_add_records '{"docid": "DOCID", "sheet_id": "SHEETID", "records": [{"values": {"任务名称": [{"type": "text", "text": "完成需求文档"}], "优先级": [{"text": "高"}]}}]}'`

各字段类型的值格式参见 [单元格值格式参考](references/cell-value-formats.md)。

> ⚠️ **图片（IMAGE）/ 文件（ATTACHMENT）字段**：**必须且只能**直接在 cell value 中传入本地路径（`image_path` / `file_path`），格式见下方示例。**严禁**调用 `upload_doc_image`、`upload_doc_file` 或任何上传接口，**严禁**进行 base64 编码——无论文件大小、无论 API 返回何种错误，均不得绕过此规则。若 `image_path` / `file_path` 方式返回错误，应直接将错误码和错误信息告知用户，**不得**尝试其他上传方式。
>
> 图片字段示例：`"封面": [{"image_path": "/path/to/img.png", "title": "图片标题"}]`
> 文件字段示例：`"文件": [{"file_path": "/path/to/file.pdf"}]`

> ⚠️ 若返回 `errcode: 851003` 或 `errmsg` 包含 `no authority`（通常是企业可见范围 > 10 人的规模限制），切换到 Webhook 兜底方案，详见 [webhook-fallback.md](references/webhook-fallback.md)。

### smartsheet_update_records

**调用前**必须先了解目标表的字段类型（通过 `smartsheet_get_fields`），并查看[单元格值格式参考](references/cell-value-formats.md)，了解做法后再实施。

更新一行或多行记录，单次建议在 500 行内。需提供 record_id（通过 `smartsheet_get_records` 获取）。支持通过 `key_type` 指定 values 的 key 使用字段标题或字段 ID：

- `CELL_VALUE_KEY_TYPE_FIELD_TITLE`：key 为字段标题
- `CELL_VALUE_KEY_TYPE_FIELD_ID`：key 为字段 ID

使用 `wecom_mcp` tool 调用 `wecom_mcp call doc smartsheet_update_records '{"docid": "DOCID", "sheet_id": "SHEETID", "key_type": "CELL_VALUE_KEY_TYPE_FIELD_ID", "records": [{"record_id": "RECORDID", "values": {"FIELDID": [{"type": "text", "text": "更新后的内容"}]}}]}'`

**注意**：创建时间、最后编辑时间、创建人、最后编辑人字段不可更新。

> ⚠️ **图片（IMAGE）/ 文件（ATTACHMENT）字段**：**必须且只能**直接在 cell value 中传入本地路径（`image_path` / `file_path`），格式见下方示例。**严禁**调用 `upload_doc_image`、`upload_doc_file` 或任何上传接口，**严禁**进行 base64 编码——无论文件大小、无论 API 返回何种错误，均不得绕过此规则。若 `image_path` / `file_path` 方式返回错误，应直接将错误码和错误信息告知用户，**不得**尝试其他上传方式。
>
> 图片字段示例：`"封面": [{"image_path": "/path/to/img.png", "title": "图片标题"}]`
> 文件字段示例：`"文件": [{"file_path": "/path/to/file.pdf"}]`

> ⚠️ 若返回 `errcode: 851003` 或 `errmsg` 包含 `no authority`（通常是企业可见范围 > 10 人的规模限制），切换到 Webhook 兜底方案，详见 [webhook-fallback.md](references/webhook-fallback.md)。注意 Webhook 只能更新通过 Webhook 写入的记录，人工创建的记录无法更新。

### smartsheet_delete_records

删除一行或多行记录，单次必须在 500 行内。**操作不可逆**。record_id 通过 `smartsheet_get_records` 获取。

使用 `wecom_mcp` tool 调用 `wecom_mcp call doc smartsheet_delete_records '{"docid": "DOCID", "sheet_id": "SHEETID", "record_ids": ["RECORDID1", "RECORDID2"]}'`

## 典型工作流

1. **读取数据** → 使用 `wecom_mcp` tool 调用 `wecom_mcp call doc smartsheet_get_records '{"docid":"DOCID","sheet_id":"SHEETID"}'`
2. **写入数据** → 先 `smartsheet_get_fields` 了解列类型 → 若涉及成员（USER）字段，先通过 `wecom-contact-lookup` 的 `get_userlist` 查找人员 userid → `smartsheet_add_records` 写入
3. **更新数据** → 先 `smartsheet_get_records` 获取 record_id → 若涉及成员（USER）字段，先通过 `wecom-contact-lookup` 的 `get_userlist` 查找人员 userid → `smartsheet_update_records` 更新
4. **写入失败 fallback** → 第 2/3 步返回 `errcode: 851003` / `no authority`（通常是企业可见范围 > 10 人的规模限制）时 → 请用户临时提供目标表的 Webhook 地址 + schema 示例 JSON（不保存到本地）→ 按 [webhook-fallback.md](references/webhook-fallback.md) 构造请求体发送
5. 若涉及**图片（IMAGE）或文件（ATTACHMENT）**字段，**必须且只能**直接在 cell value 中传入本地路径（`image_path` / `file_path`）。**严禁**调用 `upload_doc_image`、`upload_doc_file` 或任何上传接口，**严禁**进行 base64 编码——无论文件大小、无论 API 返回何种错误，均不得绕过此规则。若返回错误，直接将错误码和错误信息告知用户，不得尝试其他上传方式。传入格式参考 [单元格值格式参考](references/cell-value-formats.md)。
6. **删除数据** → 先 `smartsheet_get_records` 确认 record_id → `smartsheet_delete_records` 删除

> **注意**：成员（USER）类型字段需要填写 `user_id`，不能直接使用姓名。必须先通过 `wecom-contact-lookup` 技能的 `get_userlist` 接口按姓名查找到对应的 `userid` 后再使用。
> **注意**：图片（IMAGE）或文件（ATTACHMENT）字段**必须且只能**直接在 cell value 中传入本地路径（`image_path` / `file_path`）。**严禁**调用 `upload_doc_image`、`upload_doc_file` 或任何上传接口，**严禁**进行 base64 编码——无论文件大小、无论 API 返回何种错误，均不得绕过此规则。若返回错误，直接将错误码和错误信息告知用户，不得尝试其他上传方式。格式参考 [单元格值格式参考](references/cell-value-formats.md)。