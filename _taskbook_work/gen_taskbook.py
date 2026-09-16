# -*- coding: utf-8 -*-
"""生成 SxyBrick 毕业设计任务书（攀枝花学院，仿写模板结构）"""
from docx import Document
from docx.shared import Pt, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_ALIGN_VERTICAL
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

OUT = r"E:\kcsj2026\card\new_card\SxyBrick-毕业设计任务书.docx"

doc = Document()

# ---------- 页面设置：A4，边距 2.5cm ----------
sec = doc.sections[0]
sec.page_width = Cm(21.0)
sec.page_height = Cm(29.7)
sec.top_margin = Cm(2.5)
sec.bottom_margin = Cm(2.5)
sec.left_margin = Cm(2.5)
sec.right_margin = Cm(2.5)

# ---------- 工具函数 ----------
def set_run(run, zh_font="宋体", size=12, bold=False, en_font="Arial"):
    run.font.name = en_font
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.color.rgb = None  # 黑色
    run._element.rPr.rFonts.set(qn("w:eastAsia"), zh_font)

def add_para(text, zh_font="宋体", size=12, bold=False, align=WD_ALIGN_PARAGRAPH.JUSTIFY,
             indent_chars=2, line_spacing=1.5, space_after=0):
    p = doc.add_paragraph()
    p.alignment = align
    pf = p.paragraph_format
    pf.line_spacing = line_spacing
    pf.space_after = Pt(space_after)
    pf.space_before = Pt(0)
    if indent_chars:
        # 首行缩进 2 字符
        pPr = p._p.get_or_add_pPr()
        ind = pPr.find(qn("w:ind"))
        if ind is None:
            ind = OxmlElement("w:ind")
            pPr.append(ind)
        ind.set(qn("w:firstLineChars"), str(indent_chars * 100))
    r = p.add_run(text)
    set_run(r, zh_font, size, bold)
    return p

def set_cell(cell, text, size=10.5, bold=False, align=WD_ALIGN_PARAGRAPH.CENTER,
             v_align=WD_ALIGN_VERTICAL.CENTER):
    cell.vertical_alignment = v_align
    # 清默认段落
    cell.paragraphs[0].text = ""
    lines = text.split("\n")
    first = True
    for ln in lines:
        p = cell.paragraphs[0] if first else cell.add_paragraph()
        first = False
        p.alignment = align
        pf = p.paragraph_format
        pf.line_spacing = 1.0
        pf.space_after = Pt(0)
        pf.space_before = Pt(0)
        # 清除缩进（继承 Normal 的首行缩进会干扰居中）
        pPr = p._p.get_or_add_pPr()
        ind = pPr.find(qn("w:ind"))
        if ind is None:
            ind = OxmlElement("w:ind")
            pPr.append(ind)
        ind.set(qn("w:firstLineChars"), "0")
        ind.set(qn("w:leftChars"), "0")
        r = p.add_run(ln)
        set_run(r, "宋体", size, bold)

def set_table_borders(table):
    """外框 1 磅(8)，内部 0.5 磅(4)"""
    tbl = table._tbl
    tblPr = tbl.tblPr
    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right"):
        el = OxmlElement("w:" + edge)
        el.set(qn("w:val"), "single")
        el.set(qn("w:sz"), "8")
        el.set(qn("w:color"), "000000")
        borders.append(el)
    for edge in ("insideH", "insideV"):
        el = OxmlElement("w:" + edge)
        el.set(qn("w:val"), "single")
        el.set(qn("w:sz"), "4")
        el.set(qn("w:color"), "000000")
        borders.append(el)
    tblPr.append(borders)

def shade_cell(cell, fill="D9D9D9"):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), fill)
    tcPr.append(shd)

# ---------- 标题 ----------
tp = doc.add_paragraph()
tp.alignment = WD_ALIGN_PARAGRAPH.CENTER
tp.paragraph_format.space_after = Pt(0)
tp.paragraph_format.line_spacing = 1.2
r = tp.add_run("本科毕业设计（论文）任务书")
set_run(r, "黑体", 18, True)

tp2 = doc.add_paragraph()
tp2.alignment = WD_ALIGN_PARAGRAPH.CENTER
tp2.paragraph_format.space_after = Pt(12)
tp2.paragraph_format.line_spacing = 1.2
r = tp2.add_run("（由指导教师填写）")
set_run(r, "楷体", 12, False)

# ---------- 题目表（4列×2行） ----------
table1 = doc.add_table(rows=2, cols=4)
table1.alignment = WD_TABLE_ALIGNMENT.CENTER
table1.autofit = False
# 列宽：标签窄、值宽
widths = [Cm(2.6), Cm(5.2), Cm(2.6), Cm(5.0)]
for row in table1.rows:
    for i, c in enumerate(row.cells):
        c.width = widths[i]

# 行0：题目名称 | 值（合并 c1-c3）
set_cell(table1.cell(0, 0), "题目名称", bold=True)
merged = table1.cell(0, 1).merge(table1.cell(0, 2)).merge(table1.cell(0, 3))
set_cell(merged, "基于FSRS间隔重复算法与PWA的智能卡片学习系统设计与实现",
         size=10.5, align=WD_ALIGN_PARAGRAPH.CENTER)
merged.width = Cm(12.8)

# 行1：题目性质 | 值 | 题目来源 | 值
set_cell(table1.cell(1, 0), "题目性质", bold=True)
set_cell(table1.cell(1, 1), "□基础\n■应用（设计）\n□其它", size=10.5)
set_cell(table1.cell(1, 2), "题目来源", bold=True)
set_cell(table1.cell(1, 3), "■科研课题\n■生产社会实际\n□其他", size=10.5)

set_table_borders(table1)

# ---------- 段1 ----------
add_para("1、课题研究的主要内容及基本要求", zh_font="黑体", size=14, bold=True,
         align=WD_ALIGN_PARAGRAPH.LEFT, indent_chars=0, space_after=4)

add_para("随着移动互联网与智能终端的普及，碎片化、个性化的自主学习需求日益增长。传统记忆类学习工具多采用固定间隔的复习策略，忽略个体记忆差异，存在复习时机不科学、遗忘预测不准确、跨设备使用不便等问题。本课题基于FSRS间隔重复算法与渐进式Web应用（PWA）等技术，设计开发一套智能卡片学习系统，解决传统学习工具记忆调度不智能、数据同步困难等痛点，为个性化高效学习提供技术支撑，助力学习方法科学化与学习工具智能化。")

add_para("1.1 课题研究的主要内容", zh_font="黑体", size=12, bold=True,
         align=WD_ALIGN_PARAGRAPH.LEFT, indent_chars=0, space_after=2)

add_para("课题要求学生结合《软件工程》《数据库原理及应用》《数据结构与算法》《人机交互》《Web前端开发》《人工智能导论》等课程知识，构建基于Vue 3、IndexedDB与PWA的智能卡片学习系统。项目采用分层架构设计，便于后期功能扩展。系统服务方面，卡片管理服务支持记忆卡的创建与编辑、卡组与标签管理、回收站快照与还原、错题本及生词/熟词分类管理；记忆调度服务基于FSRS间隔重复算法，以稳定度、难度、可提取性三维模型刻画记忆状态，支持依据用户真实复习历史进行个性化权重训练与遗忘预测校准；复习引擎服务提供每日复习队列、作答耗时检索分级、快速校验、错题反思与专注计时功能；英语学习服务集成考研英语大纲词库，支持单词、词组、短句、范文四类学习对象，借助大语言模型自动补全释义、例句、搭配与长难句解析；AI学习助手服务支持学习答疑、知识图谱生成与卡片批量制作；数据协同服务基于局域网同步中枢实现多设备数据同步，采用字段级时间戳合并与挑战-响应鉴权机制，支持云备份及Anki、CSV等多格式导入导出；学习统计服务提供掌握度评估、复习热力图、遗忘预测校准、学习画像与周期性学习报告。最终形成覆盖“学习—记忆—复习—评估”全流程、可离线使用、跨设备同步的智能卡片学习系统。")

add_para("1.2 基本要求", zh_font="黑体", size=12, bold=True,
         align=WD_ALIGN_PARAGRAPH.LEFT, indent_chars=0, space_after=2)

add_para("（1）通过文献研究和实验分析，提出基于间隔重复算法的个性化记忆调度设计方案。")
add_para("（2）选择合适的技术方案，搭建开发环境，利用开发工具进行软件开发。")
add_para("（3）完成系统分析、系统设计、系统功能实现。")
add_para("（4）遵循软件工程与数据库设计规范，完成系统的功能测试和性能测试。")
add_para("（5）按照学校论文格式规范，撰写包含系统设计、系统实现、测试分析等内容的毕业设计论文。")

# ---------- 段2 ----------
add_para("2、对毕业设计（论文）成果要求", zh_font="黑体", size=14, bold=True,
         align=WD_ALIGN_PARAGRAPH.LEFT, indent_chars=0, space_after=4)
add_para("（1）设计并完成软件1套（含PWA前端应用与局域网同步中枢）。")
add_para("（2）按照攀枝花学院本科毕业论文相关规范完成毕业论文1篇。")

# ---------- 段3：参考文献 ----------
add_para("3、主要参考文献", zh_font="黑体", size=14, bold=True,
         align=WD_ALIGN_PARAGRAPH.LEFT, indent_chars=0, space_after=4)

refs = [
    "吴蕴超,罗飞,陶俊臣,等.基于ACT-R的认知间隔重复学习方法[J].华东理工大学学报(自然科学版),2025,51(3):371-379.",
    "张艺凡,赵静怡,藕才俊.基于Ebbinghaus模型的高效记忆工具设计与实现[J].计算机科学与应用,2024,14(10):22-32.",
    "Ebbinghaus H. Über das Gedächtnis[M]. Leipzig: Duncker & Humblot, 1885.",
    "Wozniak P A, Gorzelanczyk E J. Optimization of repetition spacing in the practice of learning[J]. Acta Neurobiologiae Experimentalis, 1994, 54(1): 59-62.",
    "Tabibian B, Upadhyay U, De A, et al. Enhancing human learning via spaced repetition optimization[C]//Proceedings of the 25th ACM SIGKDD International Conference on Knowledge Discovery & Data Mining. Anchorage: ACM, 2019: 537-544.",
    "Settles B, Meeder B. A trainable spaced repetition model for language learning[C]//Proceedings of the 54th Annual Meeting of the Association for Computational Linguistics. Berlin: ACL, 2016: 1848-1858.",
    "Zaidi A, Caines A, Moore R, et al. Adaptive forgetting curves for spaced repetition language learning[C]//International Conference on Artificial Intelligence in Education. Cham: Springer, 2020.",
    "Karpicke J D, Roediger H L. The critical importance of retrieval for learning[J]. Science, 2008, 319(5865): 966-968.",
    "Kang S H K. Spaced repetition promotes efficient and effective learning: Policy implications for instruction[J]. Policy Insights from the Behavioral and Brain Sciences, 2016, 3(1): 12-19.",
    "Reddy S, Levine S, Dragan A. Accelerating human learning with deep reinforcement learning[C]//NeurIPS 2017 Workshop. 2017.",
]
for i, ref in enumerate(refs, 1):
    p = doc.add_paragraph()
    pf = p.paragraph_format
    pf.line_spacing = 1.5
    pf.space_after = Pt(0)
    # 悬挂缩进 2 字符
    pPr = p._p.get_or_add_pPr()
    ind = OxmlElement("w:ind")
    ind.set(qn("w:leftChars"), "200")
    ind.set(qn("w:hangingChars"), "200")
    pPr.append(ind)
    r = p.add_run(f"[{i}]{ref}")
    set_run(r, "宋体", 12, False)

# ---------- 段4：进程计划表 ----------
add_para("4、毕业设计（论文）工作进程计划", zh_font="黑体", size=14, bold=True,
         align=WD_ALIGN_PARAGRAPH.LEFT, indent_chars=0, space_after=4)

table2 = doc.add_table(rows=6, cols=3)
table2.alignment = WD_TABLE_ALIGNMENT.CENTER
table2.autofit = False
w2 = [Cm(1.8), Cm(5.4), Cm(8.2)]
for row in table2.rows:
    for i, c in enumerate(row.cells):
        c.width = w2[i]

headers = ["序号", "设计（论文）工作进度", "日期（起止周数）"]
rows_data = [
    ["1", "开题报告", "2026年12月9日 -- 2026年12月26日"],
    ["2", "实施调研/实验阶段", "2027年1月1日 -- 2027年3月20日"],
    ["3", "完成初稿", "2027年3月21日 -- 2027年4月5日"],
    ["4", "修改定稿", "2027年4月6日 -- 2027年5月8日"],
    ["5", "答辩", "2027年5月19日 -- 2027年5月21日"],
]
for j, h in enumerate(headers):
    set_cell(table2.cell(0, j), h, bold=True)
    shade_cell(table2.cell(0, j), "D9D9D9")
for i, rd in enumerate(rows_data, 1):
    for j, val in enumerate(rd):
        align = WD_ALIGN_PARAGRAPH.CENTER if j != 2 else WD_ALIGN_PARAGRAPH.LEFT
        set_cell(table2.cell(i, j), val, align=align)

set_table_borders(table2)

doc.save(OUT)
print("SAVED:", OUT)
