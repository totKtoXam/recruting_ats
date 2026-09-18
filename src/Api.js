function setupApiAccess() {
  const props =
    PropertiesService
      .getScriptProperties();

  let apiKey =
    props.getProperty(
      APP_CONFIG.PROPERTIES.API_KEY
    );

  if (!apiKey) {
    apiKey =
      'ats_' +
      Utilities
        .getUuid()
        .replace(/-/g, '');

    props.setProperty(
      APP_CONFIG.PROPERTIES.API_KEY,
      apiKey
    );
  }

  return {
    apiKey,
    webAppUrl:
      ScriptApp
        .getService()
        .getUrl()
  };
}


function doPost(event) {
  try {
    ensureSchema_();

    const body =
      parseApiBody_(event);

    requireApiKey_(
      event,
      body
    );

    const action =
      String(
        event &&
        event.parameter &&
        event.parameter.api ||
        body.action ||
        ''
      ).trim();

    if (
      action ===
      'candidate-draft'
    ) {
      return jsonResponse_(
        createCandidateDraft_(
          body
        )
      );
    }

    return jsonResponse_({
      ok: false,
      error:
        'Неизвестный API action.'
    });
  } catch (error) {
    return jsonResponse_({
      ok: false,
      error:
        error &&
        error.message
          ? error.message
          : String(error)
    });
  }
}


function handleApiGet_(event) {
  try {
    ensureSchema_();

    requireApiKey_(
      event,
      {}
    );

    const action =
      String(
        event &&
        event.parameter &&
        event.parameter.api ||
        ''
      ).trim();

    if (action === 'references') {
      return jsonResponse_({
        ok: true,
        webAppUrl:
          ScriptApp
            .getService()
            .getUrl(),
        vacancies:
          getVacancies().map(
            vacancy => ({
              id:
                vacancy[
                  'Vacancy ID'
                ],
              number:
                vacancy['№'],
              name:
                vacancy['Вакансия'],
              status:
                vacancy['Статус']
            })
          ),
        sources:
          getSources().map(
            source => ({
              id:
                source[
                  'Source ID'
                ],
              number:
                source['№'],
              name:
                source['Название']
            })
          ),
        responsibles:
          getResponsibles().map(
            responsible => ({
              id:
                responsible[
                  'Responsible ID'
                ],
              number:
                responsible['№'],
              lastName:
                responsible[
                  'Фамилия'
                ],
              firstName:
                responsible[
                  'Имя'
                ],
              middleName:
                responsible[
                  'Отчество'
                ],
              fullName:
                responsible[
                  'ФИО'
                ],
              stages:
                responsible.stages
            })
          )
      });
    }

    if (action === 'meta') {
      return jsonResponse_({
        ok: true,
        webAppUrl:
          ScriptApp
            .getService()
            .getUrl(),
        version:
          'recruiting-ats'
      });
    }

    return jsonResponse_({
      ok: false,
      error:
        'Неизвестный API action.'
    });
  } catch (error) {
    return jsonResponse_({
      ok: false,
      error:
        error &&
        error.message
          ? error.message
          : String(error)
    });
  }
}


function requireApiKey_(
  event,
  body
) {
  const expected =
    PropertiesService
      .getScriptProperties()
      .getProperty(
        APP_CONFIG.PROPERTIES.API_KEY
      );

  if (!expected) {
    throw new Error(
      'API не настроен. Выполните setupApiAccess().'
    );
  }

  const supplied =
    String(
      event &&
      event.parameter &&
      event.parameter.api_key ||
      body &&
      body.apiKey ||
      ''
    );

  if (
    !supplied ||
    supplied !== expected
  ) {
    throw new Error(
      'Некорректный API key.'
    );
  }
}


function parseApiBody_(event) {
  const raw =
    event &&
    event.postData &&
    event.postData.contents
      ? event.postData.contents
      : '';

  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      'Body должен быть JSON.'
    );
  }
}


function jsonResponse_(payload) {
  return ContentService
    .createTextOutput(
      JSON.stringify(payload)
    )
    .setMimeType(
      ContentService.MimeType.JSON
    );
}
