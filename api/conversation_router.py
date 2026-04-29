from datetime import datetime, timezone
from typing import List, Optional, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.auth_router import _get_current_user, get_db
from api.database.models import Conversation, ConversationMessage

router = APIRouter(prefix="/conversations", tags=["conversations"])


class ConversationOut(BaseModel):
    id: str
    userId: str
    repoOwner: str
    repoName: str
    repoType: str
    title: Optional[str] = None
    createdAt: datetime
    updatedAt: datetime


class CreateConversationRequest(BaseModel):
    repo_owner: str = Field(..., alias="repoOwner")
    repo_name: str = Field(..., alias="repoName")
    repo_type: str = Field("github", alias="repoType")
    title: Optional[str] = None

    class Config:
        allow_population_by_field_name = True


class ConversationMessageOut(BaseModel):
    id: str
    conversationId: str
    role: Literal["user", "assistant"]
    content: str
    tokenCount: Optional[int] = None
    createdAt: datetime


class CreateConversationMessageRequest(BaseModel):
    role: Literal["user", "assistant"]
    content: str
    token_count: Optional[int] = Field(None, alias="tokenCount")

    class Config:
        allow_population_by_field_name = True


def _serialize_conversation(row: Conversation) -> ConversationOut:
    return ConversationOut(
        id=row.id,
        userId=row.user_id,
        repoOwner=row.repo_owner,
        repoName=row.repo_name,
        repoType=row.repo_type,
        title=row.title,
        createdAt=row.created_at,
        updatedAt=row.updated_at,
    )


def _serialize_message(row: ConversationMessage) -> ConversationMessageOut:
    return ConversationMessageOut(
        id=row.id,
        conversationId=row.conversation_id,
        role=row.role,  # type: ignore[arg-type]
        content=row.content,
        tokenCount=row.token_count,
        createdAt=row.created_at,
    )


@router.get("", response_model=List[ConversationOut])
async def list_conversations(
    repo_owner: str = Query(..., alias="repoOwner"),
    repo_name: str = Query(..., alias="repoName"),
    repo_type: str = Query("github", alias="repoType"),
    current_user=Depends(_get_current_user),
    db: AsyncSession = Depends(get_db),
):
    stmt = (
        select(Conversation)
        .where(
            Conversation.user_id == current_user.id,
            Conversation.repo_owner == repo_owner,
            Conversation.repo_name == repo_name,
            Conversation.repo_type == repo_type,
        )
        .order_by(Conversation.updated_at.desc())
    )
    result = await db.execute(stmt)
    conversations = result.scalars().all()
    return [_serialize_conversation(row) for row in conversations]


@router.post("", response_model=ConversationOut, status_code=status.HTTP_201_CREATED)
async def create_conversation(
    body: CreateConversationRequest,
    current_user=Depends(_get_current_user),
    db: AsyncSession = Depends(get_db),
):
    conversation = Conversation(
        user_id=current_user.id,
        repo_owner=body.repo_owner,
        repo_name=body.repo_name,
        repo_type=body.repo_type,
        title=body.title,
    )
    db.add(conversation)
    await db.commit()
    await db.refresh(conversation)
    return _serialize_conversation(conversation)


@router.get("/{conversation_id}/messages", response_model=List[ConversationMessageOut])
async def list_conversation_messages(
    conversation_id: str,
    current_user=Depends(_get_current_user),
    db: AsyncSession = Depends(get_db),
):
    conversation = await db.get(Conversation, conversation_id)
    if conversation is None or conversation.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="对话不存在")

    stmt = (
        select(ConversationMessage)
        .where(ConversationMessage.conversation_id == conversation_id)
        .order_by(ConversationMessage.created_at)
    )
    result = await db.execute(stmt)
    messages = result.scalars().all()
    return [_serialize_message(row) for row in messages]


@router.post(
    "/{conversation_id}/messages",
    response_model=ConversationMessageOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_conversation_message(
    conversation_id: str,
    body: CreateConversationMessageRequest,
    current_user=Depends(_get_current_user),
    db: AsyncSession = Depends(get_db),
):
    conversation = await db.get(Conversation, conversation_id)
    if conversation is None or conversation.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="对话不存在")

    message = ConversationMessage(
        conversation_id=conversation.id,
        role=body.role,
        content=body.content,
        token_count=body.token_count,
    )
    conversation.updated_at = datetime.now(timezone.utc)
    db.add(message)
    await db.commit()
    await db.refresh(message)
    return _serialize_message(message)
