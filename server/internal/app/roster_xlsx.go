package app

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"path"
	"strconv"
	"strings"
)

const (
	maxRosterXLSXSize     int64 = 5 << 20
	maxRosterUploadBody   int64 = 6 << 20
	maxXLSXArchiveEntries       = 10000
	maxXLSXEntrySize      int64 = 16 << 20
	maxXLSXUncompressed   int64 = 32 << 20
	maxRosterRows               = 1000
)

type xlsxWorkbook struct {
	Sheets []struct {
		RelationshipID string `xml:"id,attr"`
	} `xml:"sheets>sheet"`
}

type xlsxRelationships struct {
	Items []struct {
		ID     string `xml:"Id,attr"`
		Type   string `xml:"Type,attr"`
		Target string `xml:"Target,attr"`
	} `xml:"Relationship"`
}

type xlsxSharedStrings struct {
	Items []xlsxRichText `xml:"si"`
}

type xlsxRichText struct {
	Text string        `xml:"t"`
	Runs []xlsxTextRun `xml:"r"`
}

type xlsxTextRun struct {
	Text string `xml:"t"`
}

func (t xlsxRichText) value() string {
	if len(t.Runs) == 0 {
		return t.Text
	}
	var b strings.Builder
	b.WriteString(t.Text)
	for _, run := range t.Runs {
		b.WriteString(run.Text)
	}
	return b.String()
}

type xlsxWorksheet struct {
	Rows []xlsxRow `xml:"sheetData>row"`
}

type xlsxRow struct {
	Number int        `xml:"r,attr"`
	Cells  []xlsxCell `xml:"c"`
}

type xlsxCell struct {
	Reference string       `xml:"r,attr"`
	Type      string       `xml:"t,attr"`
	Value     string       `xml:"v"`
	Inline    xlsxRichText `xml:"is"`
	Formula   *struct{}    `xml:"f"`
}

type parsedXLSXRow struct {
	number int
	values map[int]string
}

func readRosterUpload(reader *multipart.Reader) (string, []byte, error) {
	var classID string
	var fileData []byte
	seenClassID, seenFile := false, false
	for {
		part, e := reader.NextPart()
		if errors.Is(e, io.EOF) {
			break
		}
		if e != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(e, &tooLarge) {
				return "", nil, fail(413, "FILE_TOO_LARGE", "上传内容过大")
			}
			return "", nil, bad("request", "multipart 上传格式不正确")
		}
		switch part.FormName() {
		case "classId":
			if seenClassID {
				part.Close()
				return "", nil, bad("classId", "classId 只能提供一次")
			}
			seenClassID = true
			raw, e := io.ReadAll(io.LimitReader(part, 129))
			part.Close()
			if e != nil {
				return "", nil, bad("classId", "无法读取班级编号")
			}
			if len(raw) > 128 {
				return "", nil, bad("classId", "班级编号过长")
			}
			classID = strings.TrimSpace(string(raw))
		case "file":
			if seenFile {
				part.Close()
				return "", nil, bad("file", "file 只能提供一次")
			}
			seenFile = true
			if !strings.EqualFold(path.Ext(part.FileName()), ".xlsx") {
				part.Close()
				return "", nil, bad("file", "仅支持 .xlsx 文件")
			}
			fileData, e = io.ReadAll(io.LimitReader(part, maxRosterXLSXSize+1))
			part.Close()
			if e != nil {
				var tooLarge *http.MaxBytesError
				if errors.As(e, &tooLarge) || int64(len(fileData)) > maxRosterXLSXSize {
					return "", nil, fail(413, "FILE_TOO_LARGE", "XLSX文件不能超过5 MiB")
				}
				return "", nil, bad("file", "无法读取XLSX文件")
			}
			if int64(len(fileData)) > maxRosterXLSXSize {
				return "", nil, fail(413, "FILE_TOO_LARGE", "XLSX文件不能超过5 MiB")
			}
		default:
			part.Close()
			return "", nil, bad("request", "multipart 仅支持 classId 和 file 字段")
		}
	}
	if !seenClassID || classID == "" {
		return "", nil, bad("classId", "请提供班级编号")
	}
	if !seenFile || len(fileData) == 0 {
		return "", nil, bad("file", "请选择非空的XLSX文件")
	}
	return classID, fileData, nil
}

func parseRosterXLSX(data []byte) ([]rosterRow, error) {
	zr, e := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if e != nil {
		return nil, bad("file", "XLSX文件结构无效")
	}
	if len(zr.File) == 0 || len(zr.File) > maxXLSXArchiveEntries {
		return nil, bad("file", "XLSX压缩包条目数量无效")
	}
	entries := make(map[string]*zip.File, len(zr.File))
	var total uint64
	for _, f := range zr.File {
		if f.UncompressedSize64 > uint64(maxXLSXEntrySize) {
			return nil, bad("file", "XLSX压缩包展开内容过大")
		}
		if total > uint64(maxXLSXUncompressed)-f.UncompressedSize64 {
			return nil, bad("file", "XLSX压缩包展开内容过大")
		}
		total += f.UncompressedSize64
		if _, exists := entries[f.Name]; exists {
			return nil, bad("file", "XLSX压缩包包含重复条目")
		}
		entries[f.Name] = f
	}
	read := func(name string, required bool) ([]byte, error) {
		f := entries[name]
		if f == nil {
			if required {
				return nil, bad("file", "XLSX缺少必要文件")
			}
			return nil, nil
		}
		rc, e := f.Open()
		if e != nil {
			return nil, bad("file", "无法读取XLSX文件")
		}
		defer rc.Close()
		raw, e := io.ReadAll(io.LimitReader(rc, maxXLSXEntrySize+1))
		if e != nil || int64(len(raw)) > maxXLSXEntrySize {
			return nil, bad("file", "XLSX压缩包展开内容过大")
		}
		return raw, nil
	}
	workbookXML, e := read("xl/workbook.xml", true)
	if e != nil {
		return nil, e
	}
	relsXML, e := read("xl/_rels/workbook.xml.rels", true)
	if e != nil {
		return nil, e
	}
	var workbook xlsxWorkbook
	var rels xlsxRelationships
	if xml.Unmarshal(workbookXML, &workbook) != nil || xml.Unmarshal(relsXML, &rels) != nil {
		return nil, bad("file", "XLSX工作簿结构无效")
	}
	targets := make(map[string]string, len(rels.Items))
	for _, rel := range rels.Items {
		if strings.HasSuffix(rel.Type, "/worksheet") {
			targets[rel.ID] = rel.Target
		}
	}
	var worksheetName string
	for _, sheet := range workbook.Sheets {
		if target := targets[sheet.RelationshipID]; target != "" {
			worksheetName, e = resolveXLSXTarget(target)
			if e != nil {
				return nil, e
			}
			break
		}
	}
	if worksheetName == "" {
		return nil, bad("file", "XLSX中没有工作表")
	}
	worksheetXML, e := read(worksheetName, true)
	if e != nil {
		return nil, e
	}
	var worksheet xlsxWorksheet
	if e = xml.Unmarshal(worksheetXML, &worksheet); e != nil {
		return nil, bad("file", "XLSX工作表结构无效")
	}
	shared := []string{}
	sharedXML, e := read("xl/sharedStrings.xml", false)
	if e != nil {
		return nil, e
	}
	if len(sharedXML) > 0 {
		var values xlsxSharedStrings
		if e = xml.Unmarshal(sharedXML, &values); e != nil {
			return nil, bad("file", "XLSX共享字符串结构无效")
		}
		shared = make([]string, len(values.Items))
		for i := range values.Items {
			shared[i] = values.Items[i].value()
		}
	}
	rows := make([]parsedXLSXRow, 0, len(worksheet.Rows))
	previousRow := 0
	for _, row := range worksheet.Rows {
		rowNumber := row.Number
		if rowNumber <= previousRow {
			rowNumber = previousRow + 1
		}
		previousRow = rowNumber
		cells := map[int]string{}
		nextColumn := 0
		for _, cell := range row.Cells {
			column := nextColumn
			if cell.Reference != "" {
				column, e = xlsxColumn(cell.Reference)
				if e != nil {
					return nil, bad("file", "XLSX单元格引用无效")
				}
			}
			value, e := xlsxCellText(cell, shared)
			if e != nil {
				return nil, e
			}
			cells[column] = value
			nextColumn = column + 1
		}
		empty := true
		for _, value := range cells {
			if strings.TrimSpace(value) != "" {
				empty = false
				break
			}
		}
		if empty {
			continue
		}
		rows = append(rows, parsedXLSXRow{number: rowNumber, values: cells})
	}
	return rowsToRoster(rows)
}

func resolveXLSXTarget(target string) (string, error) {
	target = strings.ReplaceAll(target, "\\", "/")
	if strings.HasPrefix(target, "/") {
		target = strings.TrimPrefix(target, "/")
	} else {
		target = path.Join("xl", target)
	}
	target = path.Clean(target)
	if target == "xl" || !strings.HasPrefix(target, "xl/") {
		return "", bad("file", "XLSX工作表路径无效")
	}
	return target, nil
}

func xlsxColumn(reference string) (int, error) {
	if reference == "" {
		return 0, fmt.Errorf("missing cell reference")
	}
	column := 0
	i := 0
	for i < len(reference) {
		c := reference[i]
		if c >= 'a' && c <= 'z' {
			c -= 'a' - 'A'
		}
		if c < 'A' || c > 'Z' {
			break
		}
		column = column*26 + int(c-'A'+1)
		if column > 16384 {
			return 0, fmt.Errorf("column out of range")
		}
		i++
	}
	if i == 0 {
		return 0, fmt.Errorf("missing column")
	}
	if i < len(reference) {
		if _, e := strconv.ParseInt(reference[i:], 10, 64); e != nil {
			return 0, fmt.Errorf("invalid row")
		}
	}
	return column - 1, nil
}

func xlsxCellText(cell xlsxCell, shared []string) (string, error) {
	if cell.Formula != nil {
		return "", nil
	}
	switch cell.Type {
	case "s":
		index, e := strconv.Atoi(strings.TrimSpace(cell.Value))
		if e != nil || index < 0 || index >= len(shared) {
			return "", bad("file", "XLSX共享字符串索引无效")
		}
		return shared[index], nil
	case "inlineStr":
		return cell.Inline.value(), nil
	default:
		return cell.Value, nil
	}
}

func normalizeXLSXHeader(value string) string {
	value = strings.TrimSpace(strings.TrimPrefix(value, "\uFEFF"))
	value = strings.ToLower(value)
	return strings.Join(strings.Fields(value), " ")
}

func xlsxHeaderColumn(value string) (studentNo, name bool) {
	switch normalizeXLSXHeader(value) {
	case "学号", "学生学号", "student no", "studentno", "student number", "student id":
		return true, false
	case "姓名", "学生姓名", "student name", "name":
		return false, true
	default:
		return false, false
	}
}

func rowsToRoster(rows []parsedXLSXRow) ([]rosterRow, error) {
	studentColumn, nameColumn := 0, 1
	firstDataRow := 0
	searchLimit := len(rows)
	if searchLimit > 20 {
		searchLimit = 20
	}
	for i := 0; i < searchLimit; i++ {
		foundStudent, foundName := -1, -1
		for column, value := range rows[i].values {
			isStudent, isName := xlsxHeaderColumn(value)
			if isStudent {
				foundStudent = column
			}
			if isName {
				foundName = column
			}
		}
		if foundStudent >= 0 && foundName >= 0 && foundStudent != foundName {
			studentColumn, nameColumn = foundStudent, foundName
			firstDataRow = i + 1
			break
		}
	}
	out := []rosterRow{}
	for _, row := range rows[firstDataRow:] {
		studentNo := row.values[studentColumn]
		name := row.values[nameColumn]
		if strings.TrimSpace(studentNo) == "" && strings.TrimSpace(name) == "" {
			continue
		}
		out = append(out, rosterRow{StudentNo: studentNo, Name: name, RowNumber: row.number})
		if len(out) > maxRosterRows {
			return nil, bad("rows", "每次导入1–1000行")
		}
	}
	if len(out) == 0 {
		return nil, bad("rows", "每次导入1–1000行")
	}
	return out, nil
}

func (a *App) rosterXLSX(w http.ResponseWriter, r *http.Request) error {
	actor, e := a.admin(r)
	if e != nil {
		return e
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxRosterUploadBody)
	reader, e := r.MultipartReader()
	if e != nil {
		return bad("request", "请使用multipart/form-data上传XLSX文件")
	}
	classID, data, e := readRosterUpload(reader)
	if e != nil {
		return e
	}
	rows, e := parseRosterXLSX(data)
	if e != nil {
		return e
	}
	preview, e := a.previewRoster(actor, classID, rows)
	if e != nil {
		return e
	}
	ok(w, 200, preview)
	return nil
}
