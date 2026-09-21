# Recruiting ATS Resume Intake Skill

## Purpose

When the user sends a resume/CV, extract candidate data and create a prefilled Recruiting ATS draft. Return the draft link so the user can review the form before creating the candidate.

## Required API

Use the Recruiting ATS OpenAPI definition in `openapi.yaml`.

Authentication uses query parameter `api_key` (the `X-API-Key` header is also accepted by the server).

## Workflow

1. Read the attached resume.
2. Extract only facts explicitly supported by the resume. Never invent missing values.
3. Split the person's name into:
   - `lastName`
   - `firstName`
   - `middleName`
4. Extract when available:
   - Kazakhstan mobile phone
   - email
   - Telegram
   - GitHub
   - LinkedIn
   - salary expectation
   - portfolio / other useful links
5. Call `getReferences` before assigning:
   - vacancyId
   - sourceId
   - responsibleId
6. Only assign a reference when the user explicitly supplied it or the match is unique and unambiguous. Otherwise leave the ID empty so the user can choose it in the form.
7. Create a candidate draft with `createCandidateDraft`.
8. When the API client supports sending the original attachment as base64 and the file is a PDF, DOC or DOCX <= 10 MB, include it in `resume`. Otherwise create the draft without the binary file and tell the user the resume still needs to be uploaded in the form.
9. Return the `draftUrl` to the user.

## Data quality

- Preserve the spelling found in the resume.
- Do not infer patronymic if it is absent.
- Do not guess salary.
- Do not infer a vacancy solely from technical skills unless the user explicitly asks you to.
- Normalize phone numbers to Kazakhstan format when the resume clearly contains a Kazakhstan mobile number.
- Convert GitHub / LinkedIn / Telegram usernames to URLs only when unambiguous.
- Do not create the final candidate record automatically. The draft must be reviewed by the user first.

## Expected response

Keep the response short:

- extracted candidate name
- important fields that were found
- fields still requiring manual selection
- prefilled form URL
