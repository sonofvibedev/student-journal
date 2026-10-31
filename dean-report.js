// Отчёт для деканата (Excel) по образцу деканата (obr.xlsx).
// Строки — студенты по алфавиту, колонки — учебные дни месяца (пн–сб) по две: «У» (уважительные часы)
// и «Н» (неуважительные), в конце «Всего У» и «Всего Н».
// Стили скопированы с ячеек образца по ролям — не менять на глаз.
(function (root) {
  const S = {
    corner: {"font":{"size":10,"color":{"theme":1},"name":"Arial","family":2,"charset":204},"border":{"left":{"style":"medium","color":{"argb":"FFCCCCCC"}},"right":{"style":"thick","color":{"argb":"FF000000"}},"top":{"style":"medium","color":{"argb":"FFCCCCCC"}},"bottom":{"style":"medium","color":{"argb":"FFCCCCCC"}}},"fill":{"type":"pattern","pattern":"solid","fgColor":{"argb":"FFFFE599"},"bgColor":{"indexed":64}},"alignment":{"wrapText":true}},
    month: {"numFmt":"mmm-yy","font":{"bold":true,"size":10,"color":{"theme":1},"name":"Times New Roman","family":1,"charset":204},"border":{"left":{"style":"medium","color":{"argb":"FFCCCCCC"}},"right":{"style":"thick","color":{"argb":"FF000000"}},"top":{"style":"medium","color":{"argb":"FFCCCCCC"}},"bottom":{"style":"medium","color":{"argb":"FF000000"}}},"fill":{"type":"pattern","pattern":"solid","fgColor":{"argb":"FFFFE599"},"bgColor":{"indexed":64}},"alignment":{"wrapText":true}},
    date: {"numFmt":"mm-dd-yy","font":{"size":10,"color":{"theme":1},"name":"Times New Roman","family":1,"charset":204},"border":{"left":{"style":"thick","color":{"argb":"FF000000"}},"top":{"style":"thick","color":{"argb":"FF000000"}},"bottom":{"style":"thick","color":{"argb":"FF000000"}}},"alignment":{"horizontal":"center","wrapText":true}},
    un: {"font":{"size":10,"color":{"theme":1},"name":"Times New Roman","family":1,"charset":204},"border":{"left":{"style":"medium","color":{"argb":"FFCCCCCC"}},"right":{"style":"thick","color":{"argb":"FF000000"}},"top":{"style":"medium","color":{"argb":"FFCCCCCC"}},"bottom":{"style":"thick","color":{"argb":"FF000000"}}},"alignment":{"horizontal":"center","wrapText":true}},
    totalU: {"font":{"size":10,"color":{"theme":1},"name":"Times New Roman","family":1,"charset":204},"border":{"left":{"style":"thick","color":{"argb":"FF000000"}},"right":{"style":"thick","color":{"argb":"FF000000"}},"top":{"style":"thick","color":{"argb":"FF000000"}}},"fill":{"type":"pattern","pattern":"solid","fgColor":{"argb":"FF00FF00"},"bgColor":{"indexed":64}},"alignment":{"horizontal":"center","vertical":"middle","wrapText":true}},
    totalN: {"font":{"size":10,"color":{"theme":1},"name":"Times New Roman","family":1,"charset":204},"border":{"left":{"style":"thick","color":{"argb":"FF000000"}},"right":{"style":"thick","color":{"argb":"FF000000"}},"top":{"style":"thick","color":{"argb":"FF000000"}}},"fill":{"type":"pattern","pattern":"solid","fgColor":{"argb":"FFFF0000"},"bgColor":{"indexed":64}},"alignment":{"horizontal":"center","vertical":"middle","wrapText":true}},
    name: {"font":{"size":10,"color":{"theme":1},"name":"Times New Roman","family":1,"charset":204},"border":{"left":{"style":"medium","color":{"argb":"FF000000"}},"right":{"style":"thick","color":{"argb":"FF000000"}},"top":{"style":"medium","color":{"argb":"FFCCCCCC"}},"bottom":{"style":"medium","color":{"argb":"FFCCCCCC"}}},"alignment":{"wrapText":true}},
    cell: {"font":{"size":10,"color":{"theme":1},"name":"Arial","family":2,"charset":204},"border":{"left":{"style":"medium","color":{"argb":"FFCCCCCC"}},"right":{"style":"medium","color":{"argb":"FF000000"}},"top":{"style":"medium","color":{"argb":"FFCCCCCC"}},"bottom":{"style":"medium","color":{"argb":"FF000000"}}},"alignment":{"wrapText":true}},
    weekEnd: {"font":{"size":10,"color":{"theme":1},"name":"Arial","family":2,"charset":204},"border":{"left":{"style":"medium","color":{"argb":"FFCCCCCC"}},"right":{"style":"thick","color":{"argb":"FF000000"}},"top":{"style":"medium","color":{"argb":"FFCCCCCC"}},"bottom":{"style":"medium","color":{"argb":"FF000000"}}},"alignment":{"wrapText":true}},
    total: {"font":{"size":10,"color":{"theme":1},"name":"Arial","family":2,"charset":204},"border":{"left":{"style":"medium","color":{"argb":"FFCCCCCC"}},"right":{"style":"thick","color":{"argb":"FF000000"}},"top":{"style":"medium","color":{"argb":"FFCCCCCC"}},"bottom":{"style":"medium","color":{"argb":"FF000000"}}},"alignment":{"horizontal":"right","wrapText":true}},
    dateEnd: {"border":{"right":{"style":"thick","color":{"argb":"FF000000"}},"top":{"style":"thick","color":{"argb":"FF000000"}},"bottom":{"style":"thick","color":{"argb":"FF000000"}}}},
    totalUEnd: {"border":{"left":{"style":"thick","color":{"argb":"FF000000"}},"right":{"style":"thick","color":{"argb":"FF000000"}},"bottom":{"style":"thick","color":{"argb":"FF000000"}}}},
    totalNEnd: {"border":{"left":{"style":"thick","color":{"argb":"FF000000"}},"right":{"style":"thick","color":{"argb":"FF000000"}},"bottom":{"style":"thick","color":{"argb":"FF000000"}}}},
  };

  // Excel хранит дату без часового пояса — передаём полночь UTC, иначе дата съедет на день.
  const utc = (y, m, d) => new Date(Date.UTC(y, m, d));
  const iso = (y, m, d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  // month — 0..11. students: [{id, lastName, firstName, middleName?}], absences: [{studentId, date, isExcused, totalHours}]
  function buildDeanReport(ExcelJS, students, absences, year, month) {
    const days = [];
    const last = new Date(year, month + 1, 0).getDate();
    for (let d = 1; d <= last; d++) {
      const dow = new Date(year, month, d).getDay();
      if (dow !== 0) days.push({ d, sat: dow === 6 });
    }
    days[days.length - 1].sat = true; // правый край таблицы — тоже жирная граница

    // Часы за день по всем предметам: hours[studentId|date] = [уваж, неуваж]
    const hours = {};
    absences.forEach(a => {
      const k = a.studentId + '|' + a.date;
      const h = hours[k] || (hours[k] = [0, 0]);
      h[a.isExcused ? 0 : 1] += Number(a.totalHours) || 0;
    });

    const fio = s => [s.lastName, s.firstName, s.middleName].filter(Boolean).join(' ');
    const ordered = [...students].sort((a, b) => fio(a).localeCompare(fio(b), 'ru'));

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Лист1');
    ws.getColumn(1).width = 22.109375;
    const totalCol = 2 + days.length * 2; // «Всего У»; «Всего Н» — следующая

    const put = (r, c, value, style) => {
      const cell = ws.getCell(r, c);
      if (value !== undefined) cell.value = value;
      cell.style = JSON.parse(JSON.stringify(style));
    };

    put(1, 1, undefined, S.corner);
    put(2, 1, utc(year, month, 1), S.month);
    days.forEach((day, i) => {
      const c = 2 + i * 2;
      put(1, c, utc(year, month, day.d), S.date);
      put(1, c + 1, undefined, S.dateEnd);
      ws.mergeCellsWithoutStyle(1, c, 1, c + 1);
      put(2, c, 'У', S.un);
      put(2, c + 1, 'Н', S.un);
    });
    put(1, totalCol, 'Всего У', S.totalU);
    put(2, totalCol, undefined, S.totalUEnd);
    put(1, totalCol + 1, 'Всего Н', S.totalN);
    put(2, totalCol + 1, undefined, S.totalNEnd);
    ws.mergeCellsWithoutStyle(1, totalCol, 2, totalCol);
    ws.mergeCellsWithoutStyle(1, totalCol + 1, 2, totalCol + 1);
    ws.getRow(1).height = 15.6;
    ws.getRow(2).height = 15;

    ordered.forEach((s, i) => {
      const r = 3 + i;
      let sumU = 0, sumN = 0;
      put(r, 1, fio(s), S.name);
      days.forEach((day, j) => {
        const [u, n] = hours[s.id + '|' + iso(year, month, day.d)] || [0, 0];
        sumU += u; sumN += n;
        put(r, 2 + j * 2, u || undefined, S.cell);
        put(r, 3 + j * 2, n || undefined, day.sat ? S.weekEnd : S.cell);
      });
      put(r, totalCol, sumU, S.total);
      put(r, totalCol + 1, sumN, S.total);
      ws.getRow(r).height = 27.6;
    });
    return wb;
  }

  if (typeof module !== 'undefined') module.exports = { buildDeanReport };
  else root.buildDeanReport = buildDeanReport;
})(this);
