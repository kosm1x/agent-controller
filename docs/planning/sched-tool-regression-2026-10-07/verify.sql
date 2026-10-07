SELECT instr(description, 'web_search al menos una vez') > 0 AS search_mandatory, length(description) AS len
FROM scheduled_tasks WHERE schedule_id = '9081e6cd-fa0b-45f7-ad67-71deabc99275';
